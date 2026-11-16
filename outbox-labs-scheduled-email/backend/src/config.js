import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4000),
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET || 'development-only-change-me',
  databaseFile: process.env.DATABASE_FILE || './data/outbox.sqlite',
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  concurrency: Number(process.env.QUEUE_CONCURRENCY || 3),
  rateMax: Number(process.env.QUEUE_RATE_MAX || 5),
  rateDuration: Number(process.env.QUEUE_RATE_DURATION_MS || 10000),
  etherealAutoCreate: process.env.ETHEREAL_AUTO_CREATE === 'true',
  ai: {
    baseUrl: process.env.AI_API_BASE_URL || '',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  }
};
