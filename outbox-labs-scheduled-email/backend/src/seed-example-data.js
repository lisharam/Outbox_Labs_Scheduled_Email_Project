import { randomUUID } from 'node:crypto';
import { db } from './db.js';

const userEmail = process.argv[2]?.trim().toLowerCase();
if (!userEmail) {
  console.error('Usage: npm run seed:examples -- <existing-account-email>');
  db.close();
  process.exitCode = 1;
} else {
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(userEmail);
  if (!user) {
    console.error(`No account found for ${userEmail}. Create an account first.`);
    db.close();
    process.exitCode = 1;
  } else {
    const exampleCount = db.prepare("SELECT COUNT(*) AS count FROM emails WHERE user_id=? AND subject LIKE '[Example]%'")
      .get(user.id).count;

    if (exampleCount) {
      console.log(`Example entries already exist for ${userEmail}; no rows changed.`);
      db.close();
    } else {
      const now = Date.now();
      const timestamp = (offsetMs) => new Date(now + offsetMs).toISOString();
      const hour = 60 * 60 * 1000;
      const examples = [
        {
          to: 'example-customer1@example.test',
          subject: '[Example] Welcome message sent',
          body: 'Example entry only. No email was sent. A welcome message for previewing the sent status and activity log.',
          scheduledAt: timestamp(-2 * hour),
          createdAt: timestamp(-3 * hour),
          sentAt: timestamp(-2 * hour),
          status: 'sent',
          attempts: [{ attempt: 1, outcome: 'sent', error: null, createdAt: timestamp(-2 * hour) }],
        },
        {
          to: 'example-customer2@example.test',
          subject: '[Example] Monthly update sent',
          body: 'Example entry only. No email was sent. A monthly product update for the sent status and analytics chart.',
          scheduledAt: timestamp(-26 * hour),
          createdAt: timestamp(-27 * hour),
          sentAt: timestamp(-26 * hour),
          status: 'sent',
          attempts: [{ attempt: 1, outcome: 'sent', error: null, createdAt: timestamp(-26 * hour) }],
        },
        {
          to: 'example-invalid1@example.test',
          subject: '[Example] Invalid recipient failure',
          body: 'Example entry only. No delivery was attempted. This entry shows where a permanent delivery failure appears.',
          scheduledAt: timestamp(-4 * hour),
          createdAt: timestamp(-5 * hour),
          error: 'Example failure: recipient address was rejected.',
          status: 'failed',
          attempts: [
            { attempt: 1, outcome: 'retrying', error: 'Example transient connection error.', createdAt: timestamp(-4.5 * hour) },
            { attempt: 2, outcome: 'failed', error: 'Example failure: recipient address was rejected.', createdAt: timestamp(-4 * hour) },
          ],
        },
        {
          to: 'example-invalid2@example.test',
          subject: '[Example] SMTP rejection failure',
          body: 'Example entry only. No delivery was attempted. This entry demonstrates failure details and retry history.',
          scheduledAt: timestamp(-28 * hour),
          createdAt: timestamp(-29 * hour),
          error: 'Example failure: SMTP rejected the message.',
          status: 'failed',
          attempts: [{ attempt: 1, outcome: 'failed', error: 'Example failure: SMTP rejected the message.', createdAt: timestamp(-28 * hour) }],
        },
        {
          to: 'example-cancelled1@example.test',
          subject: '[Example] Cancelled event reminder',
          body: 'Example entry only. No email was sent. This entry demonstrates the cancelled status.',
          scheduledAt: timestamp(2 * 24 * hour),
          createdAt: timestamp(-6 * hour),
          cancelledAt: timestamp(-5 * hour),
          error: 'Example cancellation; no email was sent.',
          status: 'cancelled',
        },
        {
          to: 'example-cancelled2@example.test',
          subject: '[Example] Cancelled follow-up',
          body: 'Example entry only. No email was sent. This entry demonstrates cancelled follow-ups in the list.',
          scheduledAt: timestamp(4 * 24 * hour),
          createdAt: timestamp(-30 * hour),
          cancelledAt: timestamp(-29 * hour),
          error: 'Example cancellation; no email was sent.',
          status: 'cancelled',
        },
      ];

      const insertEmail = db.prepare(`
        INSERT INTO emails(id,user_id,to_email,subject,body,scheduled_at,timezone,status,created_at,sent_at,error,cancelled_at)
        VALUES(@id,@userId,@to,@subject,@body,@scheduledAt,'Asia/Kolkata',@status,@createdAt,@sentAt,@error,@cancelledAt)
      `);
      const insertAttempt = db.prepare(`
        INSERT INTO email_attempts(email_id,attempt,outcome,error,created_at)
        VALUES(?,?,?,?,?)
      `);
      const seed = db.transaction(() => {
        for (const example of examples) {
          const id = randomUUID();
          insertEmail.run({
            ...example,
            id,
            userId: user.id,
            sentAt: example.sentAt || null,
            error: example.error || null,
            cancelledAt: example.cancelledAt || null,
          });
          for (const attempt of example.attempts || []) {
            insertAttempt.run(id, attempt.attempt, attempt.outcome, attempt.error, attempt.createdAt);
          }
        }
      });

      try {
        seed();
        console.log(`Added ${examples.length} clearly labeled example entries for ${userEmail}. No email was sent.`);
      } finally {
        db.close();
      }
    }
  }
}
