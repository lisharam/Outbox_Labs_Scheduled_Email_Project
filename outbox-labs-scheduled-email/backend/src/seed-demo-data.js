import { randomUUID } from 'node:crypto';
import { db } from './db.js';

const userEmail = process.argv[2]?.trim().toLowerCase();
if (!userEmail) {
  console.error('Usage: npm run seed:demo -- <existing-account-email>');
  db.close();
  process.exitCode = 1;
} else {
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(userEmail);
  if (!user) {
    console.error(`No account found for ${userEmail}. Create an account first.`);
    db.close();
    process.exitCode = 1;
  } else {
    const alreadySeeded = db.prepare("SELECT COUNT(*) AS count FROM emails WHERE user_id=? AND subject LIKE '[DEMO]%'")
      .get(user.id).count;

    if (alreadySeeded) {
      console.log(`Demo data already exists for ${userEmail}; no rows changed.`);
      db.close();
    } else {
      const now = Date.now();
      const isoAt = (offsetMs) => new Date(now + offsetMs).toISOString();
      const day = 24 * 60 * 60 * 1000;
      const emails = [
        ...[
          ['Campaign launch recap', 0, 'Asia/Kolkata'],
          ['Welcome to the product tour', -1, 'America/Los_Angeles'],
          ['Your weekly product digest', -2, 'Europe/London'],
          ['Thanks for joining our webinar', -4, 'Asia/Singapore'],
          ['A quick onboarding follow-up', -6, 'America/New_York'],
        ].map(([label, daysAgo, timezone]) => {
          const sentAt = isoAt(daysAgo * day - 60 * 60 * 1000);
          return {
            to: `contact-${Math.abs(daysAgo)}@example.test`,
            subject: `[DEMO] ${label}`,
            body: `This is sample content for the ${label.toLowerCase()} email. No message was sent.`,
            scheduledAt: isoAt(daysAgo * day - 90 * 60 * 1000),
            createdAt: isoAt(daysAgo * day - 2 * 60 * 60 * 1000),
            sentAt,
            timezone,
            status: 'sent',
          };
        }),
        {
          to: 'invalid-recipient@example.test',
          subject: '[DEMO] Delivery failure with retry history',
          body: 'Sample failed delivery for exercising failure details and retry controls.',
          scheduledAt: isoAt(-3 * 60 * 60 * 1000),
          createdAt: isoAt(-4 * 60 * 60 * 1000),
          sentAt: null,
          timezone: 'UTC',
          status: 'failed',
          error: 'Demo failure: the reserved .test domain cannot receive email.',
          attempts: [
            { attempt: 1, outcome: 'retrying', error: 'Demo transient SMTP connection failure.', createdAt: isoAt(-3.5 * 60 * 60 * 1000) },
            { attempt: 2, outcome: 'failed', error: 'Demo failure: the reserved .test domain cannot receive email.', createdAt: isoAt(-3 * 60 * 60 * 1000) },
          ],
        },
        {
          to: 'unknown-contact@example.test',
          subject: '[DEMO] Invalid recipient address',
          body: 'Sample permanent delivery failure with an explanatory error.',
          scheduledAt: isoAt(-5 * day),
          createdAt: isoAt(-5 * day - 60 * 60 * 1000),
          sentAt: null,
          timezone: 'Europe/Paris',
          status: 'failed',
          error: 'Demo failure: recipient address is not deliverable.',
          attempts: [
            { attempt: 1, outcome: 'failed', error: 'Demo failure: recipient address is not deliverable.', createdAt: isoAt(-5 * day) },
          ],
        },
        ...[
          ['Product announcement preview', 1],
          ['Monthly customer update', 3],
          ['Post-event thank-you', 6],
        ].map(([label, daysAhead]) => ({
          to: `preview-${daysAhead}@example.test`,
          subject: `[DEMO] ${label}`,
          body: `This reserved-address sample lets you try editing, rescheduling, cancellation, and calendar drag-and-drop. ${label}.`,
          scheduledAt: isoAt(daysAhead * day),
          createdAt: isoAt(-10 * 60 * 1000),
          sentAt: null,
          timezone: 'Asia/Kolkata',
          status: 'scheduled',
        })),
        ...[
          ['Old campaign reminder', 2],
          ['Previous event invitation', 4],
        ].map(([label, daysAhead]) => ({
          to: `cancelled-${daysAhead}@example.test`,
          subject: `[DEMO] ${label}`,
          body: 'Sample cancelled email for the management status filter.',
          scheduledAt: isoAt(daysAhead * day),
          createdAt: isoAt(-2 * day),
          sentAt: null,
          timezone: 'UTC',
          status: 'cancelled',
          cancelledAt: isoAt(-1 * day),
          error: 'Cancelled by user (demo data)',
        })),
      ];

      const insertEmail = db.prepare(`
        INSERT INTO emails(id,user_id,to_email,subject,body,scheduled_at,timezone,status,created_at,sent_at,error,cancelled_at)
        VALUES(@id,@userId,@to,@subject,@body,@scheduledAt,@timezone,@status,@createdAt,@sentAt,@error,@cancelledAt)
      `);
      const insertAttempt = db.prepare(`
        INSERT INTO email_attempts(email_id,attempt,outcome,error,created_at)
        VALUES(?,?,?,?,?)
      `);

      const seed = db.transaction(() => {
        for (const email of emails) {
          email.id = randomUUID();
          insertEmail.run({
            ...email,
            userId: user.id,
            error: email.error || null,
            cancelledAt: email.cancelledAt || null,
          });
          for (const attempt of email.attempts || (email.status === 'sent'
            ? [{ attempt: 1, outcome: 'sent', error: null, createdAt: email.sentAt }]
            : [])) {
            insertAttempt.run(email.id, attempt.attempt, attempt.outcome, attempt.error, attempt.createdAt);
          }
        }
      });

      try {
        seed();
        console.log(`Added ${emails.length} demo emails for ${userEmail}. Scheduled samples use reserved .test addresses.`);
      } finally {
        db.close();
      }
    }
  }
}
