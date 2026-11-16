import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';

export const connection = new IORedis({
  ...config.redis,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
connection.on('error', (err) => console.error('[redis]', err.message));

export const emailQueue = new Queue('scheduled-emails', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 2000,
  },
});

export async function enqueueEmail(email) {
  const delay = Math.max(0, new Date(email.scheduled_at).getTime() - Date.now());
  return emailQueue.add('send-email', { emailId: email.id }, {
    jobId: email.id,
    delay,
  });
}
