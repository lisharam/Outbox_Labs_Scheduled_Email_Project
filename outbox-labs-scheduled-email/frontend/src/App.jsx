import React, { useEffect, useMemo, useState } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const savedTimezone = (() => {
  const saved = localStorage.getItem('outbox_timezone');
  try {
    if (saved) new Intl.DateTimeFormat('en-US', { timeZone: saved });
    return saved || browserTimezone;
  } catch {
    return browserTimezone;
  }
})();
const timezoneOptions = [...new Set([browserTimezone, savedTimezone, 'UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'])];
const partsInTimezone = (value, timezone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
};
const dateKeyInTimezone = (value, timezone) => {
  const parts = partsInTimezone(value, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};
const dateTimeInputInTimezone = (value, timezone) => {
  const parts = partsInTimezone(value, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
};
const zonedDateTimeToIso = (value, timezone) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Choose a valid date and time.');
  const [, year, month, day, hour, minute] = match.map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = partsInTimezone(timestamp, timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const adjustment = target - represented;
    timestamp += adjustment;
    if (adjustment === 0) break;
  }
  const verified = partsInTimezone(timestamp, timezone);
  if (verified.year !== year || verified.month !== month || verified.day !== day || verified.hour !== hour || verified.minute !== minute) {
    throw new Error('That local time does not exist in the selected timezone because of a daylight-saving change.');
  }
  return new Date(timestamp).toISOString();
};

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('outbox_token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('outbox_user') || 'null'));
  const [mode, setMode] = useState('login');
  const [auth, setAuth] = useState({ name: '', email: '', password: '' });
  const [emails, setEmails] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState('list');
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  });
  const [timezone, setTimezone] = useState(savedTimezone);
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [editingId, setEditingId] = useState('');
  const [assistantTask, setAssistantTask] = useState('improve');
  const [assistantTone, setAssistantTone] = useState('professional');
  const [assistantMode, setAssistantMode] = useState('local');
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [attemptsByEmail, setAttemptsByEmail] = useState({});
  const [expandedAttempts, setExpandedAttempts] = useState('');
  const [form, setForm] = useState({ to: '', subject: '', body: '', scheduledAt: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function request(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function authenticate(e) {
    e.preventDefault(); setBusy(true); setMessage('');
    try {
      const data = await request(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(auth) });
      setToken(data.token); setUser(data.user);
      localStorage.setItem('outbox_token', data.token); localStorage.setItem('outbox_user', JSON.stringify(data.user));
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  }

  async function loadEmails() {
    try {
      const [emailRows, analyticsData] = await Promise.all([request('/emails'), request('/analytics')]);
      setEmails(emailRows);
      setAnalytics(analyticsData);
    }
    catch (err) { setMessage(err.message); if (err.message.includes('token')) logout(); }
  }

  async function cancelEmail(id) {
    if (!window.confirm('Cancel this scheduled email?')) return;
    setBusy(true); setMessage('');
    try {
      await request(`/emails/${id}`, { method: 'DELETE' });
      setMessage('Scheduled email cancelled successfully.');
      await loadEmails();
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  }

  async function retryEmail(id) {
    setBusy(true); setMessage('');
    try {
      const result = await request(`/emails/${id}/retry`, { method: 'POST' });
      setMessage(result.status === 'queue_pending'
        ? 'Retry saved. It will be queued automatically when Redis is available.'
        : 'Email queued for retry.');
      await loadEmails();
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  }

  async function loadAttempts(id) {
    try {
      const attempts = await request(`/emails/${id}/attempts`);
      setAttemptsByEmail(current => ({ ...current, [id]: attempts }));
      setExpandedAttempts(id);
    } catch (err) { setMessage(err.message); }
  }

  async function assistWithWriting() {
    setAssistantBusy(true); setMessage('');
    try {
      const result = await request('/assistant/generate', {
        method: 'POST',
        body: JSON.stringify({ task: assistantTask, text: form.body, tone: assistantTone, mode: assistantMode }),
      });
      setForm(current => assistantTask === 'subject'
        ? ({ ...current, subject: result.text })
        : ({ ...current, body: result.text }));
      const description = result.mode === 'local' ? 'Offline helper updated your text' : 'Writing assistant updated your text';
      setMessage(`${assistantTask === 'subject' ? 'Suggested a subject' : description}. Review it before scheduling.`);
    } catch (err) { setMessage(err.message); }
    finally { setAssistantBusy(false); }
  }

  async function rescheduleOnCalendar(item, dayKey) {
    const time = dateTimeInputInTimezone(item.scheduledAt, timezone).slice(11);
    let scheduledAt;
    try {
      scheduledAt = zonedDateTimeToIso(`${dayKey}T${time}`, timezone);
    } catch (err) {
      setMessage(err.message);
      return;
    }

    setBusy(true); setMessage('');
    try {
      const result = await request(`/emails/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          to: item.to,
          subject: item.subject,
          body: item.body,
          scheduledAt,
          timezone,
        }),
      });
      setMessage(result.status === 'queue_pending'
        ? 'Reschedule saved. It will be queued when Redis is available.'
        : 'Email rescheduled.');
      await loadEmails();
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  }

  function editEmail(item) {
    setEditingId(item.id);
    changeTimezone(item.timezone || browserTimezone);
    setForm({ to: item.to, subject: item.subject, body: item.body, scheduledAt: dateTimeInputInTimezone(item.scheduledAt, item.timezone || browserTimezone) });
    setMessage('Update the email details and schedule, then save your changes.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function stopEditing() {
    setEditingId('');
    setForm({ to: '', subject: '', body: '', scheduledAt: '' });
    setMessage('');
  }

  useEffect(() => { if (token) loadEmails(); }, [token]);

  useEffect(() => {
    if (!token) return;
    const timer = setInterval(loadEmails, 8000);
    return () => clearInterval(timer);
  }, [token]);

  function logout() {
    setToken(''); setUser(null); setEmails([]); setAnalytics(null);
    localStorage.removeItem('outbox_token'); localStorage.removeItem('outbox_user');
  }

  async function schedule(e) {
    e.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await request(editingId ? `/emails/${editingId}` : '/emails', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify({ ...form, scheduledAt: zonedDateTimeToIso(form.scheduledAt, timezone), timezone }),
      });
      const wasEditing = Boolean(editingId);
      setEditingId('');
      setForm({ to: '', subject: '', body: '', scheduledAt: '' });
      setMessage(result.status === 'queue_pending'
        ? 'Email saved. It will be queued automatically when Redis is available.'
        : wasEditing ? 'Scheduled email updated successfully.' : 'Email scheduled successfully.');
      await loadEmails();
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  }

  const scheduled = useMemo(() => emails.filter(x => x.status === 'scheduled'), [emails]);
  const queuePending = useMemo(() => emails.filter(x => x.status === 'queue_pending'), [emails]);
  const sent = useMemo(() => emails.filter(x => x.status === 'sent'), [emails]);
  const failed = useMemo(() => emails.filter(x => x.status === 'failed'), [emails]);
  const cancelled = useMemo(() => emails.filter(x => x.status === 'cancelled'), [emails]);
  const visibleEmails = useMemo(() => emails.filter((item) => {
    const matchesStatus = filter === 'all' || item.status === filter;
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [item.to, item.subject, item.body].some((value) => value.toLowerCase().includes(query));
    const date = dateKeyInTimezone(item.scheduledAt, timezone);
    const matchesFrom = !fromDate || date >= fromDate;
    const matchesTo = !toDate || date <= toDate;
    return matchesStatus && matchesSearch && matchesFrom && matchesTo;
  }), [emails, filter, search, fromDate, toDate, timezone]);
  const chartMax = Math.max(1, ...(analytics?.daily || []).map((day) => day.total));
  const minDate = dateTimeInputInTimezone(new Date(Date.now() + 60000).toISOString(), timezone);
  const calendarDays = useMemo(() => {
    const first = new Date(Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth(), 1));
    const mondayOffset = (first.getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_value, index) => {
      const date = new Date(first);
      date.setUTCDate(index - mondayOffset + 1);
      return {
        date,
        key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`,
        inMonth: date.getUTCMonth() === calendarMonth.getUTCMonth(),
      };
    });
  }, [calendarMonth]);
  const calendarEmails = useMemo(() => {
    const byDate = new Map();
    for (const item of emails.filter(email => ['scheduled', 'queue_pending'].includes(email.status))) {
      const key = dateKeyInTimezone(item.scheduledAt, timezone);
      byDate.set(key, [...(byDate.get(key) || []), item]);
    }
    return byDate;
  }, [emails, timezone]);

  function changeTimezone(value) {
    if (form.scheduledAt) {
      try {
        const scheduledAt = zonedDateTimeToIso(form.scheduledAt, timezone);
        setForm(current => ({ ...current, scheduledAt: dateTimeInputInTimezone(scheduledAt, value) }));
      } catch (err) {
        setMessage(err.message);
      }
    }
    setTimezone(value);
    localStorage.setItem('outbox_timezone', value);
  }

  if (!token) return <main className="auth-shell"><section className="auth-card">
    <div className="brand-mark">O</div><p className="eyebrow">OUTBOX LABS · SDE INTERN ASSIGNMENT</p>
    <h1>{mode === 'login' ? 'Welcome back' : 'Create your workspace'}</h1>
    <p className="muted">Schedule, track, and manage email delivery.</p>
    <form onSubmit={authenticate}>
      {mode === 'register' && <label>Your name<input required value={auth.name} onChange={e=>setAuth({...auth,name:e.target.value})} placeholder="Lisha Ram"/></label>}
      <label>Email address<input required type="email" value={auth.email} onChange={e=>setAuth({...auth,email:e.target.value})} placeholder="you@example.com"/></label>
      <label>Password<input required minLength="8" type="password" value={auth.password} onChange={e=>setAuth({...auth,password:e.target.value})} placeholder="At least 8 characters"/></label>
      <button disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
    </form>
    {message && <p className="notice">{message}</p>}
    <p className="switch">{mode === 'login' ? 'New here?' : 'Already registered?'} <button className="text-button" onClick={()=>{setMode(mode==='login'?'register':'login');setMessage('')}}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
  </section></main>;

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark small">O</div><span>outbox<span className="brand-light"> / scheduler</span></span></div>
      <div className="profile"><span>{user?.name || user?.email}</span><button className="ghost" onClick={logout}>Sign out</button></div>
    </header>
    <section className="welcome"><div><p className="eyebrow">EMAIL OPERATIONS</p><h1>Your outbox, in control.</h1><p className="muted">Compose once. Send at exactly the right time.</p></div><span className="live-pill"><i/> SYSTEM WORKSPACE · {timezone}</span></section>
    {message && <div className="notice wide">{message}</div>}
    <section className="stats">
      <div className="stat"><span>Scheduled</span><strong>{scheduled.length + queuePending.length}</strong><small>{queuePending.length} waiting for Redis</small></div>
      <div className="stat"><span>Sent today</span><strong>{analytics?.sentToday ?? sent.length}</strong><small>{analytics?.sentThisWeek ?? sent.length} sent this week</small></div>
      <div className="stat"><span>Failed</span><strong>{failed.length}</strong><small>Needs attention</small></div>
      <div className="stat"><span>Cancelled</span><strong>{cancelled.length}</strong><small>Removed from queue</small></div>
    </section>
    <section className="panel analytics">
      <div className="panel-heading"><div><p className="eyebrow">DELIVERY PERFORMANCE</p><h2>Weekly analytics</h2></div><span className="delivery-rate">{analytics?.successRate ?? 0}% success</span></div>
      <div className="analytics-summary">
        <div><strong>{analytics?.total ?? emails.length}</strong><span>Total emails</span></div>
        <div><strong>{analytics?.sentThisWeek ?? 0}</strong><span>Sent this week</span></div>
        <div><strong>{analytics?.failureRate ?? 0}%</strong><span>Failure rate</span></div>
      </div>
      <div className="bar-chart" role="img" aria-label="Emails created per day over the last seven days">
        {(analytics?.daily || []).map((day) => (
          <div className="chart-day" key={day.day} title={`${day.total} email(s) on ${day.day}: ${day.sent} sent, ${day.failed} failed`}>
            <div className="bar-track"><i style={{ height: `${Math.max(day.total ? 8 : 0, (day.total / chartMax) * 100)}%` }} /></div>
            <span>{new Date(`${day.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}</span>
          </div>
        ))}
      </div>
      <small className="helper">Daily totals are based on email creation date and current delivery status.</small>
    </section>
    <section className="content-grid">
      <div className="panel compose"><div className="panel-heading"><div><p className="eyebrow">NEW MESSAGE</p><h2>Compose email</h2></div><span className="step">01</span></div>
        <form onSubmit={schedule}>
          <label>Recipient<input required type="email" placeholder="recipient@example.com" value={form.to} onChange={e=>setForm({...form,to:e.target.value})}/></label>
          <label>Subject<input required placeholder="A clear subject line" value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})}/></label>
          <label>Message or AI brief<textarea required rows="5" placeholder="Write your message or describe what the AI assistant should draft…" value={form.body} onChange={e=>setForm({...form,body:e.target.value})}/></label>
          <div className="assistant-controls">
            <label>Assistant mode<select value={assistantMode} onChange={(e) => setAssistantMode(e.target.value)}><option value="local">Offline helper (no API key)</option><option value="provider">AI provider (requires API key)</option></select></label>
            <label>Writing assistant<select value={assistantTask} onChange={(e) => setAssistantTask(e.target.value)}><option value="generate">Draft from brief</option><option value="improve">Improve grammar and clarity</option><option value="concise">Make concise</option><option value="warmer">Make warmer</option><option value="subject">Suggest a subject line</option></select></label>
            {assistantMode === 'provider' && <label>Tone<select value={assistantTone} onChange={(e) => setAssistantTone(e.target.value)}><option value="professional">Professional</option><option value="friendly">Friendly</option><option value="formal">Formal</option><option value="direct">Direct</option></select></label>}
            <button type="button" className="ghost" onClick={assistWithWriting} disabled={assistantBusy || busy || !form.body.trim()}>{assistantBusy ? 'Working…' : 'Assist with writing'}</button>
          </div>
          <small className="helper">{assistantMode === 'local' ? 'Offline helper uses basic spelling, punctuation, and formatting rules. It does not use or train a language model, and does not send your draft to an AI provider.' : 'AI provider mode requires AI_API_BASE_URL, AI_API_KEY, and AI_MODEL in backend/.env. Your draft is sent to that provider when you request assistance.'}</small>
          <label>Schedule timezone<select value={timezone} onChange={(e) => changeTimezone(e.target.value)}>{timezoneOptions.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          <label>Schedule date & time<input required type="datetime-local" min={minDate} value={form.scheduledAt} onChange={e=>setForm({...form,scheduledAt:e.target.value})}/></label>
          <small className="helper">This local time is converted to UTC for delivery; {timezone} is saved with the schedule.</small>
          <div className="compose-actions">
            <button disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save changes →' : 'Schedule email →'}</button>
            {editingId && <button type="button" className="ghost" onClick={stopEditing} disabled={busy}>Stop editing</button>}
          </div>
          <small className="helper">Emails are sent through Ethereal's test inbox. No real recipient delivery.</small>
        </form>
      </div>
      <div className="panel activity"><div className="panel-heading"><div><p className="eyebrow">DELIVERY OVERVIEW</p><h2>{view === 'calendar' ? 'Email calendar' : 'Recent activity'}</h2></div><div className="view-switch"><button type="button" className={`filter-chip ${view === 'list' ? 'active' : ''}`} onClick={() => setView('list')}>List</button><button type="button" className={`filter-chip ${view === 'calendar' ? 'active' : ''}`} onClick={() => setView('calendar')}>Calendar</button></div></div>
        {view === 'calendar' ? <>
          <div className="calendar-toolbar">
            <div className="calendar-month">
              <button type="button" className="mini-button" aria-label="Previous month" onClick={() => setCalendarMonth(month => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)))}>←</button>
              <strong>{calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</strong>
              <button type="button" className="mini-button" aria-label="Next month" onClick={() => setCalendarMonth(month => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)))}>→</button>
            </div>
            <label className="timezone-control">Calendar timezone<select value={timezone} onChange={(e) => changeTimezone(e.target.value)}>{timezoneOptions.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          </div>
          <p className="helper">Drag a scheduled email to another day to reschedule it; its local time is preserved.</p>
          <div className="calendar-grid">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <div className="calendar-weekday" key={day}>{day}</div>)}
            {calendarDays.map(({ date, key, inMonth }) => (
              <div
                className={`calendar-day ${inMonth ? '' : 'outside-month'}`}
                key={key}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const item = emails.find(email => email.id === event.dataTransfer.getData('text/plain'));
                  if (item && dateKeyInTimezone(item.scheduledAt, timezone) !== key) rescheduleOnCalendar(item, key);
                }}
              >
                <span className="calendar-date">{date.getUTCDate()}</span>
                {(calendarEmails.get(key) || []).map(item => (
                  <div
                    className={`calendar-event ${item.status}`}
                    key={item.id}
                    draggable={!busy}
                    onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
                    title={`${dateTimeInputInTimezone(item.scheduledAt, timezone).slice(11)} · ${item.to}`}
                  >
                    {dateTimeInputInTimezone(item.scheduledAt, timezone).slice(11)} {item.subject}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </> : <>
        <div className="tabs">
          {['all', 'scheduled', 'queue_pending', 'sent', 'failed', 'cancelled'].map(status => (
            <button key={status} type="button" className={`filter-chip ${filter === status ? 'active' : ''}`} onClick={() => setFilter(status)}>
              {status === 'all' ? 'All emails' : status === 'queue_pending' ? 'Queue pending' : status}
            </button>
          ))}
          <span className="auto-refresh">Auto-refresh · 8 sec</span>
        </div>
        <div className="email-filters">
          <label>Search<input type="search" placeholder="Subject, recipient, or message" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          <label>From<input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label>
          <label>To<input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
        </div>
        <div className="table-wrap"><table><thead><tr><th>EMAIL</th><th>SCHEDULED</th><th>STATUS</th></tr></thead><tbody>
          {visibleEmails.length === 0 ? <tr><td colSpan="3" className="empty">No emails match these filters.</td></tr> :
            visibleEmails.map(item=><React.Fragment key={item.id}><tr><td><strong>{item.subject}</strong><small>{item.to}</small>{item.previewUrl && <a href={item.previewUrl} target="_blank" rel="noreferrer">Preview email ↗</a>}{item.error && <small className="error">{item.error}</small>}{item.attemptCount > 0 && <button type="button" className="inline-button" onClick={() => expandedAttempts === item.id ? setExpandedAttempts('') : loadAttempts(item.id)}>Attempts ({item.attemptCount})</button>}</td><td>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: item.timezone || timezone }).format(new Date(item.scheduledAt))}<small>{item.timezone || timezone}</small></td><td><div className="status-cell"><span className={`status ${item.status}`}>{item.status === 'queue_pending' ? 'queue pending' : item.status}</span>{['scheduled', 'queue_pending'].includes(item.status) && <><button type="button" className="mini-button" onClick={() => editEmail(item)} disabled={busy}>Edit</button><button type="button" className="mini-button" onClick={() => cancelEmail(item.id)} disabled={busy}>Cancel</button></>}{item.status === 'failed' && <button type="button" className="mini-button" onClick={() => retryEmail(item.id)} disabled={busy}>Retry</button>}</div></td></tr>{expandedAttempts === item.id && <tr><td colSpan="3"><div className="attempt-log">{(attemptsByEmail[item.id] || []).map((attempt, index) => <div key={`${attempt.createdAt}-${index}`}><strong>Attempt {attempt.attempt} · {attempt.outcome}</strong><small>{new Date(attempt.createdAt).toLocaleString()}</small>{attempt.error && <small className="error">{attempt.error}</small>}</div>)}</div></td></tr>}</React.Fragment>)}
        </tbody></table></div>
        </>}
      </div>
    </section>
    <footer>OUTBOX SCHEDULER <span>Built with React · Express · Redis · BullMQ</span></footer>
  </main>;
}
