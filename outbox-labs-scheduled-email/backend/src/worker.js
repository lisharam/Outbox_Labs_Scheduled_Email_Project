import { UnrecoverableError, Worker } from 'bullmq';
import { connection } from './queue.js';
import { config } from './config.js';
import { db } from './db.js';
import { sendEmail } from './mailer.js';

const worker = new Worker('scheduled-emails', async (job) => {
  const row = db.prepare('SELECT * FROM emails WHERE id=?').get(job.data.emailId);
  if (!row || !['scheduled', 'queue_pending'].includes(row.status)) {
    return { skipped: true, reason: row ? `status=${row.status}` : 'missing' };
  }

  // If a job was recovered after its due time, send immediately.
  let result;
  try {
    result = await sendEmail({ to: row.to_email, subject: row.subject, body: row.body });
  } catch (err) {
    if (Number(err.responseCode) >= 500) {
      throw new UnrecoverableError(`Permanent SMTP rejection (${err.responseCode}): ${err.message}`);
    }
    throw err;
  }
  db.prepare("UPDATE emails SET status='sent', sent_at=?, preview_url=?, error=NULL WHERE id=? AND status IN ('scheduled','queue_pending')")
    .run(new Date().toISOString(), result.previewUrl, row.id);
  db.prepare("INSERT INTO email_attempts(email_id,attempt,outcome,created_at) VALUES(?,?,'sent',?)")
    .run(row.id, job.attemptsMade + 1, new Date().toISOString());
  console.log(`[worker] sent ${row.id}${result.previewUrl ? ` | preview: ${result.previewUrl}` : ''}`);
  return result;
}, {
  connection,
  concurrency: config.concurrency,
  limiter: { max: config.rateMax, duration: config.rateDuration },
});

worker.on('failed', (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err.message);
  if (!job) return;
  const isFinalFailure = err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts || 1);
  const outcome = isFinalFailure ? 'failed' : 'retrying';
  db.prepare('INSERT INTO email_attempts(email_id,attempt,outcome,error,created_at) VALUES(?,?,?,?,?)')
    .run(job.data.emailId, job.attemptsMade, outcome, err.message, new Date().toISOString());
  if (isFinalFailure) {
    db.prepare("UPDATE emails SET status='failed', error=? WHERE id=? AND status IN ('scheduled','queue_pending')")
      .run(err.message, job.data.emailId);
  }
});
worker.on('error', err => console.error('[worker] error:', err.message));
console.log(`[worker] running (concurrency=${config.concurrency}, rate=${config.rateMax}/${config.rateDuration}ms)`);

async function shutdown() {
  await worker.close();
  await connection.quit();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
