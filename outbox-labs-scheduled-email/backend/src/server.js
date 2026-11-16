import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { db } from './db.js';
import { requireAuth } from './auth.js';
import { emailQueue, enqueueEmail, connection } from './queue.js';
import { writeOffline } from './writing-assistant.js';

const app = express();
const frontendOrigins = [config.frontendOrigin];
if (config.frontendOrigin === 'http://localhost:5173') frontendOrigins.push('http://127.0.0.1:5173');
if (config.frontendOrigin === 'http://127.0.0.1:5173') frontendOrigins.push('http://localhost:5173');
app.use(cors({ origin: frontendOrigins }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

async function withQueueTimeout(operation) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Redis queue timed out')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function enqueueWithTimeout(email) {
  return withQueueTimeout(() => enqueueEmail(email));
}

function enqueueRecoveredEmail(email) {
  return withQueueTimeout(async () => {
    const existing = await emailQueue.getJob(email.id);
    if (existing) {
      const state = await existing.getState();
      if (['failed', 'completed'].includes(state)) await existing.remove();
      else return existing;
    }
    return enqueueEmail(email);
  });
}

function removePendingJob(emailId) {
  return withQueueTimeout(async () => {
    const job = await emailQueue.getJob(emailId);
    if (!job) return true;
    if (await job.getState() === 'active') return false;

    try {
      await job.remove();
      return true;
    } catch (err) {
      if (await job.getState() === 'active') return false;
      throw err;
    }
  });
}

function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || timezone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, redis: connection.status });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name?.trim() || !email?.trim() || !password || password.length < 8) {
      return res.status(400).json({ error: 'Name, valid email and password (8+ characters) are required' });
    }
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users(name,email,password_hash,created_at) VALUES(?,?,?,?)')
      .run(name.trim(), email.trim().toLowerCase(), hash, new Date().toISOString());
    const user = { id: result.lastInsertRowid, name: name.trim(), email: email.trim().toLowerCase() };
    const token = jwt.sign(user, config.jwtSecret, { expiresIn: '12h' });
    res.status(201).json({ token, user });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'Could not register account' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const userRow = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!userRow || !(await bcrypt.compare(password || '', userRow.password_hash))) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  const user = { id: userRow.id, name: userRow.name, email: userRow.email };
  const token = jwt.sign(user, config.jwtSecret, { expiresIn: '12h' });
  res.json({ token, user });
});

app.get('/api/emails', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT id,to_email AS "to",subject,body,scheduled_at AS scheduledAt,timezone,status,created_at AS createdAt,sent_at AS sentAt,error,preview_url AS previewUrl,cancelled_at AS cancelledAt,
    (SELECT COUNT(*) FROM email_attempts WHERE email_id=emails.id) AS attemptCount
    FROM emails WHERE user_id=? ORDER BY scheduled_at DESC`)
    .all(req.user.id);
  res.json(rows);
});

app.get('/api/emails/:id/attempts', requireAuth, (req, res) => {
  const email = db.prepare('SELECT id FROM emails WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!email) return res.status(404).json({ error: 'Email not found' });
  const attempts = db.prepare('SELECT attempt, outcome, error, created_at AS createdAt FROM email_attempts WHERE email_id=? ORDER BY created_at DESC, id DESC')
    .all(email.id);
  res.json(attempts);
});

app.post('/api/assistant/generate', requireAuth, async (req, res) => {
  const { text, task, tone, mode = 'local' } = req.body || {};
  const tasks = {
    generate: 'Write a complete professional email body based on the user brief.',
    improve: 'Improve clarity, grammar, and flow while preserving the original meaning.',
    concise: 'Rewrite this email to be concise while preserving the important details and meaning.',
    warmer: 'Rewrite this email in a warmer, friendly professional tone while preserving its meaning.',
    subject: 'Suggest one clear, relevant subject line for the provided email. Return only the subject line.',
  };
  const tones = ['professional', 'friendly', 'formal', 'direct'];
  if (!tasks[task] || typeof text !== 'string' || !text.trim() || text.length > 8000) {
    return res.status(400).json({ error: 'Choose a writing action and enter text of at most 8,000 characters' });
  }
  if (tone !== undefined && !tones.includes(tone)) {
    return res.status(400).json({ error: 'Choose a supported writing tone' });
  }
  if (!['local', 'provider'].includes(mode)) {
    return res.status(400).json({ error: 'Choose a supported writing assistant mode' });
  }
  if (mode === 'local') {
    return res.json({ text: writeOffline({ text: text.trim(), task }), mode: 'local' });
  }
  if (!config.ai.baseUrl || !config.ai.apiKey || !config.ai.model) {
    return res.status(503).json({ error: 'AI writing is not configured. Set AI_API_BASE_URL, AI_API_KEY, and AI_MODEL on the backend.' });
  }

  try {
    const endpoint = `${config.ai.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.ai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: 'system', content: `${tasks[task]} ${task === 'subject' ? '' : 'Return only the email body, with no commentary.'} ${tone ? `Use a ${tone} tone.` : ''}` },
          { role: 'user', content: text.trim() },
        ],
        temperature: 0.6,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.error('[assistant] provider request failed:', response.status);
      if (response.status === 401 || response.status === 403) {
        return res.status(502).json({ error: 'The AI provider rejected the API key. Check that AI_API_KEY is valid and the key has access to the selected model.' });
      }
      if (response.status === 429) {
        return res.status(502).json({ error: 'The AI provider rate-limited this request or the account has no available quota. Check the provider usage, billing, and rate limits, then try again.' });
      }
      return res.status(502).json({ error: 'The AI provider could not complete the request. Check the provider configuration and try again.' });
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      console.error('[assistant] provider returned an empty response');
      return res.status(502).json({ error: 'The AI provider returned an empty response. Please try again.' });
    }
    res.json({ text: content.trim(), mode: 'provider' });
  } catch (err) {
    console.error('[assistant] request failed:', err.message);
    res.status(502).json({ error: 'Could not reach the AI provider. Please try again.' });
  }
});

app.get('/api/analytics', requireAuth, (req, res) => {
  const now = new Date();
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const todayIso = today.toISOString();
  const weekStartIso = weekStart.toISOString();
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN status='queue_pending' THEN 1 ELSE 0 END) AS queuePending,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status='sent' AND sent_at >= ? THEN 1 ELSE 0 END) AS sentToday,
      SUM(CASE WHEN status='sent' AND sent_at >= ? THEN 1 ELSE 0 END) AS sentThisWeek
    FROM emails WHERE user_id=?
  `).get(todayIso, weekStartIso, req.user.id);
  const totals = {
    ...counts,
    scheduled: counts.scheduled || 0,
    queuePending: counts.queuePending || 0,
    sent: counts.sent || 0,
    failed: counts.failed || 0,
    cancelled: counts.cancelled || 0,
    sentToday: counts.sentToday || 0,
    sentThisWeek: counts.sentThisWeek || 0,
  };
  const dailyRows = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day,
      COUNT(*) AS total,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
    FROM emails
    WHERE user_id=? AND created_at >= ?
    GROUP BY substr(created_at, 1, 10)
  `).all(req.user.id, weekStartIso);
  const dailyByDate = new Map(dailyRows.map((row) => [row.day, row]));
  const daily = Array.from({ length: 7 }, (_value, index) => {
    const date = new Date(weekStart);
    date.setUTCDate(date.getUTCDate() + index);
    const day = date.toISOString().slice(0, 10);
    return { day, ...(dailyByDate.get(day) || { total: 0, sent: 0, failed: 0 }) };
  });
  const deliveryCount = totals.sent + totals.failed;
  res.json({
    ...totals,
    successRate: deliveryCount ? Math.round((totals.sent / deliveryCount) * 100) : 0,
    failureRate: deliveryCount ? Math.round((totals.failed / deliveryCount) * 100) : 0,
    daily,
  });
});

app.delete('/api/emails/:id', requireAuth, async (req, res) => {
  const email = db.prepare('SELECT * FROM emails WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!email) return res.status(404).json({ error: 'Email not found' });
  if (!['scheduled', 'queue_pending'].includes(email.status)) {
    return res.status(400).json({ error: 'Only pending scheduled emails can be cancelled' });
  }

  let canCancel;
  try {
    canCancel = await removePendingJob(email.id);
  } catch (err) {
    console.error(`[scheduler] could not cancel ${email.id}:`, err.message);
    return res.status(503).json({ error: 'Could not update the queue. Please try again when Redis is available.' });
  }
  if (!canCancel) {
    return res.status(409).json({ error: 'This email is already being processed and cannot be cancelled' });
  }

  const cancelledAt = new Date().toISOString();
  const result = db.prepare("UPDATE emails SET status='cancelled', cancelled_at=?, error='Cancelled by user' WHERE id=? AND user_id=? AND status IN ('scheduled','queue_pending')")
    .run(cancelledAt, email.id, req.user.id);
  if (!result.changes) return res.status(409).json({ error: 'Email status changed before it could be cancelled' });

  res.json({ id: email.id, status: 'cancelled', cancelledAt });
});

app.patch('/api/emails/:id', requireAuth, async (req, res) => {
  const email = db.prepare('SELECT * FROM emails WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!email) return res.status(404).json({ error: 'Email not found' });
  if (!['scheduled', 'queue_pending'].includes(email.status)) {
    return res.status(400).json({ error: 'Only pending scheduled emails can be edited' });
  }

  const { to, subject, body, scheduledAt, timezone } = req.body || {};
  const when = new Date(scheduledAt);
  const scheduleTimezone = timezone || email.timezone || 'UTC';
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !subject?.trim() || !body?.trim() || Number.isNaN(when.getTime()) || !isValidTimezone(scheduleTimezone)) {
    return res.status(400).json({ error: 'Enter a valid recipient, subject, body, schedule date and timezone' });
  }
  if (when.getTime() < Date.now() + 5000) return res.status(400).json({ error: 'Choose a time at least 5 seconds in the future' });
  let canEdit;
  try {
    canEdit = await removePendingJob(email.id);
  } catch (err) {
    console.error(`[scheduler] could not edit ${email.id}:`, err.message);
    return res.status(503).json({ error: 'Could not update the queue. Please try again when Redis is available.' });
  }
  if (!canEdit) {
    return res.status(409).json({ error: 'This email is already being processed and cannot be edited' });
  }

  const updatedEmail = {
    ...email,
    to_email: to.trim(),
    subject: subject.trim(),
    body: body.trim(),
    scheduled_at: when.toISOString(),
    timezone: scheduleTimezone,
    status: 'queue_pending',
  };
  const updated = db.prepare(`
    UPDATE emails SET to_email=?, subject=?, body=?, scheduled_at=?, timezone=?, status='queue_pending', error=NULL
    WHERE id=? AND user_id=? AND status IN ('scheduled','queue_pending')
  `).run(updatedEmail.to_email, updatedEmail.subject, updatedEmail.body, updatedEmail.scheduled_at, updatedEmail.timezone, email.id, req.user.id);
  if (!updated.changes) return res.status(409).json({ error: 'Email status changed before it could be edited' });

  try {
    await enqueueWithTimeout(updatedEmail);
    db.prepare("UPDATE emails SET status='scheduled', error=NULL WHERE id=? AND status='queue_pending'").run(email.id);
    res.json({ id: email.id, status: 'scheduled', scheduledAt: updatedEmail.scheduled_at });
  } catch (err) {
    db.prepare('UPDATE emails SET error=? WHERE id=? AND status=?').run(`Queue pending: ${err.message}`, email.id, 'queue_pending');
    res.status(202).json({
      id: email.id,
      status: 'queue_pending',
      scheduledAt: updatedEmail.scheduled_at,
      message: 'Changes were saved and will be queued automatically when Redis is available.',
    });
  }
});

app.post('/api/emails', requireAuth, async (req, res) => {
  const { to, subject, body, scheduledAt, timezone } = req.body || {};
  const when = new Date(scheduledAt);
  const scheduleTimezone = timezone || 'UTC';
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !subject?.trim() || !body?.trim() || Number.isNaN(when.getTime()) || !isValidTimezone(scheduleTimezone)) {
    return res.status(400).json({ error: 'Enter a valid recipient, subject, body, schedule date and timezone' });
  }
  if (when.getTime() < Date.now() + 5000) return res.status(400).json({ error: 'Choose a time at least 5 seconds in the future' });

  const email = {
    id: randomUUID(), user_id: req.user.id, to_email: to.trim(),
    subject: subject.trim(), body: body.trim(), scheduled_at: when.toISOString(), timezone: scheduleTimezone,
    status: 'queue_pending', created_at: new Date().toISOString()
  };
  db.prepare(`INSERT INTO emails(id,user_id,to_email,subject,body,scheduled_at,timezone,status,created_at)
    VALUES(@id,@user_id,@to_email,@subject,@body,@scheduled_at,@timezone,@status,@created_at)`).run(email);

  try {
    await enqueueWithTimeout(email);
    db.prepare("UPDATE emails SET status='scheduled', error=NULL WHERE id=? AND status='queue_pending'").run(email.id);
    res.status(201).json({ id: email.id, status: 'scheduled', scheduledAt: email.scheduled_at });
  } catch (err) {
    db.prepare('UPDATE emails SET error=? WHERE id=? AND status=?').run(`Queue pending: ${err.message}`, email.id, 'queue_pending');
    res.status(202).json({
      id: email.id,
      status: 'queue_pending',
      scheduledAt: email.scheduled_at,
      message: 'Email saved and will be queued automatically when Redis is available.',
    });
  }
});

app.post('/api/emails/:id/retry', requireAuth, async (req, res) => {
  const email = db.prepare('SELECT * FROM emails WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!email) return res.status(404).json({ error: 'Email not found' });
  if (email.status !== 'failed') return res.status(400).json({ error: 'Only failed emails can be retried' });

  const updated = db.prepare("UPDATE emails SET status='queue_pending', error=NULL WHERE id=? AND user_id=? AND status='failed'")
    .run(email.id, req.user.id);
  if (!updated.changes) return res.status(409).json({ error: 'Email status changed before it could be retried' });

  try {
    await enqueueRecoveredEmail({ ...email, status: 'queue_pending' });
    db.prepare("UPDATE emails SET status='scheduled', error=NULL WHERE id=? AND status='queue_pending'").run(email.id);
    res.json({ id: email.id, status: 'scheduled' });
  } catch (err) {
    db.prepare('UPDATE emails SET error=? WHERE id=? AND status=?').run(`Queue pending: ${err.message}`, email.id, 'queue_pending');
    res.status(202).json({ id: email.id, status: 'queue_pending', message: 'Retry saved and will be queued when Redis is available.' });
  }
});

// Retry pending records periodically so a Redis outage does not require an API restart.
let recovering = false;
async function recoverPendingEmails() {
  if (recovering || connection.status !== 'ready') return;
  recovering = true;
  try {
    const pending = db.prepare("SELECT * FROM emails WHERE status IN ('queue_pending','scheduled')").all();
    for (const email of pending) {
      if (email.status === 'queue_pending') {
        await enqueueRecoveredEmail(email);
      } else {
        const existing = await emailQueue.getJob(email.id);
        if (!existing) await enqueueEmail(email);
      }
      if (email.status === 'queue_pending') {
        db.prepare("UPDATE emails SET status='scheduled', error=NULL WHERE id=? AND status='queue_pending'").run(email.id);
      }
    }
    console.log(`[scheduler] checked ${pending.length} pending email(s)`);
  } finally {
    recovering = false;
  }
}

const server = app.listen(config.port, async () => {
  console.log(`API listening on http://localhost:${config.port}`);
  setInterval(() => {
    recoverPendingEmails().catch((err) => console.error('[scheduler] recovery failed:', err.message));
  }, 30_000).unref();
  recoverPendingEmails().catch((err) => console.error('[scheduler] recovery failed:', err.message));
});

async function shutdown() {
  server.close();
  await emailQueue.close();
  await connection.quit();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
