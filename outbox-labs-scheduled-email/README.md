# Outbox Labs — Scheduled Email System

tensA full-stack scheduled-email application built with React, Express, SQLite, Redis, BullMQ, and Nodemailer. Email is captured by Ethereal for testing; this project does not send campaign email to real recipients.

## Requirements

- Node.js 20 or later and npm
- Redis 6.2 or later, either installed locally or running in Docker
- An Ethereal account for test delivery, or `ETHEREAL_AUTO_CREATE=true` for a temporary account
- Optional: an OpenAI-compatible chat-completions provider for the writing assistant

`better-sqlite3` is a native Node module. Use a Node version with an available prebuilt binary or a working native build toolchain. The local Windows setup for this project was verified with Node 22.

## Project setup and installation

Open three terminals at the repository root. Start Redis, the backend API, the worker, and the frontend as described below. Keep the API, worker, and Redis running while using the app.

### 1. Start Redis

With Docker:

```powershell
docker run --name outbox-redis -p 6379:6379 -d redis:7-alpine
```

Or start your local Redis-compatible service, listening on `127.0.0.1:6379`. The backend expects Redis there by default. Check API and Redis status at `http://localhost:4000/api/health` after the API starts.

### 2. Install and configure the Express backend

```powershell
cd backend
Copy-Item .env.example .env
npm install
npm run dev
```

The Express API listens on `http://localhost:4000`. The first run creates the SQLite database at `backend/data/outbox.sqlite` by default. Set `DATABASE_FILE` in `backend/.env` to use another path.

The API handles registration and authentication, validates and stores schedules, enqueues BullMQ jobs, exposes analytics and email-management endpoints, and periodically recovers pending schedules. SQLite is the durable source of truth; Redis is used for queue coordination and delayed jobs.

### 3. Configure Ethereal Email

Create a test account at [ethereal.email/create](https://ethereal.email/create), then copy the SMTP host, port, username, and password shown by Ethereal into `backend/.env`:

```dotenv
ETHEREAL_AUTO_CREATE=false
SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
SMTP_USER=your-ethereal-username
SMTP_PASS=your-ethereal-password
```

Alternatively, set `ETHEREAL_AUTO_CREATE=true` and leave the `SMTP_*` values blank; the backend creates temporary Ethereal credentials at startup. Restart the backend after changing environment variables. Ethereal captures messages and provides preview links; it does not deliver to actual recipients.

### 4. Start the BullMQ worker

In a separate terminal:

```powershell
cd backend
npm run worker
```

The worker consumes `scheduled-emails` jobs from Redis, waits until each due time, and sends through Nodemailer using the configured SMTP account. The worker must stay running for queued messages to be processed.

### 5. Install and start the frontend

In another terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, then register an account or sign in. Set `FRONTEND_ORIGIN` in `backend/.env` if the frontend uses a different origin.

### Optional: load demo data

After registering, run this from `backend` to add labeled examples to that account:

```powershell
npm run seed:demo -- your-account@example.com
```

This command is idempotent and does not create users or send email. It uses reserved `.test` recipient addresses and adds samples for sent, failed, scheduled, and cancelled statuses, including send-attempt history.

To add clearly labeled example rows to the Sent, Failed, and Cancelled sections of an existing account, run:

```powershell
npm run seed:examples -- your-account@example.com
```

These example-only delivery outcomes are marked `[Example]`, use reserved `.test` addresses, and do not represent real sends. The command does not change existing schedules and is safe to rerun.

## Environment variables

`backend/.env.example` lists all supported settings. Keep secrets in `backend/.env`; do not commit that file or put server secrets in frontend variables.

| Variable | Purpose |
|---|---|
| `PORT` | Express API port (default `4000`). |
| `FRONTEND_ORIGIN` | Allowed frontend origin for CORS (default `http://localhost:5173`). |
| `JWT_SECRET` | JWT signing secret; replace the development value with a long random secret. |
| `DATABASE_FILE` | SQLite database path (default `./data/outbox.sqlite`, relative to the backend working directory). |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Redis connection settings (default `127.0.0.1:6379`, no password). |
| `QUEUE_CONCURRENCY` | Number of jobs this worker processes concurrently (default `3`). |
| `QUEUE_RATE_MAX`, `QUEUE_RATE_DURATION_MS` | BullMQ rate limit: maximum jobs per duration in milliseconds (defaults `5` per `10000` ms). |
| `ETHEREAL_AUTO_CREATE` | Set to `true` to create temporary Ethereal credentials when the API starts. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Explicit SMTP settings, usually copied from Ethereal. |
| `AI_API_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | Optional OpenAI-compatible AI provider settings for the writing assistant. |

### Writing assistant

The composer defaults to **Offline helper**, which works without AI credentials or an internet connection to an AI service. It applies basic spelling, punctuation, repeated-word, and formatting rules; it is not a trained language model and may not understand context. Review the result before scheduling.

To use a hosted AI model instead, select **AI provider** in the composer and configure all three settings in `backend/.env`:

```dotenv
AI_API_BASE_URL=https://api.openai.com/v1
AI_API_KEY=your-openai-api-key
AI_MODEL=gpt-4o-mini
```

Use the base URL expected by your provider (the API appends `/chat/completions`), a key accepted as a Bearer token, and a model name enabled for your account. The request sends your text to the provider only when AI provider mode is selected and you click **Assist with writing**. Never paste the API key into the frontend or commit it. Provider-specific authentication formats or unsupported OpenAI-compatible APIs may require a backend integration change.

Provider mode requires non-empty `AI_API_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` and an API restart after configuration changes. A 401/403 means the provider rejected the key or model access; a 429 indicates a provider rate limit or unavailable quota. Never paste a provider key into chat or commit it; revoke any key that has been exposed.

## System architecture

```text
Browser: React + Vite
    | HTTP requests with JWT
    v
Express API --------------------> Optional OpenAI-compatible API
    |                                (explicit writing requests only)
    | SQLite reads/writes
    v
SQLite database
    ^
    | email status and attempt updates
    |
Redis + BullMQ queue <---------- BullMQ worker
                                     |
                                     | Nodemailer / SMTP
                                     v
                              Ethereal test inbox
```

The API and worker share the SQLite database and Redis queue. SQLite persists user, email, status, and attempt records. BullMQ/Redis coordinates delayed jobs and worker processing. AI text is sent to a separately configured provider only when the user explicitly invokes the assistant.

## Email scheduling and persistence

1. The browser converts a selected wall-clock time in the chosen IANA timezone to an absolute UTC instant. The API stores the UTC schedule and timezone; daylight-saving times that do not exist are rejected.
2. The API validates the request and writes an email row with `queue_pending` status to SQLite before enqueueing.
3. The API creates a delayed BullMQ job in Redis, using the email ID as its stable job ID, then marks the row `scheduled`.
4. If Redis is unavailable or enqueueing times out, the email remains `queue_pending`. Startup and periodic recovery re-enqueue pending and scheduled rows from SQLite.
5. The worker sends due emails through SMTP and records send attempts and resulting status. Ethereal preview links are retained for sent messages.

SQLite is the source of truth for recovery after API/worker restarts, provided the database file is preserved. Stable job IDs and worker status checks reduce duplicate processing but cannot guarantee exactly-once SMTP delivery: a crash after a provider accepts a message and before the database update leaves an ambiguous result. SMTP/Ethereal does not provide an idempotency key or reconciliation API.

Calendar drag-and-drop changes the scheduled day while preserving the displayed local time. Each worker send attempt is recorded with its timestamp, outcome, and failure reason. SMTP 5xx rejection responses are treated as permanent; transient failures use BullMQ retries with exponential backoff. Failed emails can be manually retried.

## Rate limiting and worker concurrency

- Express `express-rate-limit` limits API requests per IP (120 requests per 60 seconds by default).
- BullMQ's queue limiter uses `QUEUE_RATE_MAX` jobs per `QUEUE_RATE_DURATION_MS`, coordinating throughput through Redis.
- `QUEUE_CONCURRENCY` controls how many jobs a worker process handles simultaneously. Concurrency and rate limiting are independent; multiple workers can share the queue and limiter.
- BullMQ retries transient failures with exponential backoff. Exhausted jobs are recorded as failed in SQLite and can be manually retried from the app.

## Feature mapping

| Feature | Where it is implemented | Status and notes |
|---|---|---|
| Login and registration | React auth forms; Express `/api/auth/*`; SQLite users | Implemented with JWT authentication. |
| Email composer and timezone scheduling | React composer; `POST /api/emails` | Implemented; stores UTC schedule and selected IANA timezone. |
| Visual calendar and drag-to-reschedule | React calendar; `PATCH /api/emails/:id` | Implemented for scheduled/queue-pending emails. |
| Analytics and status/date/search filters | Dashboard; `GET /api/analytics`, `GET /api/emails` | Implemented for stored statuses and recent delivery trends. |
| Edit, cancel, retry and duplicate | Email list and API management routes | Edit, cancel, and retry are implemented; duplicate is not currently exposed. |
| Delivery-attempt logs and preview links | `email_attempts`; `/api/emails/:id/attempts`; worker | Implemented for attempts recorded by the worker; sent messages may have Ethereal previews. |
| Retry and recovery | BullMQ worker; API recovery loop; SQLite | Implemented with exponential retry behavior and restart recovery. |
| Writing assistant | Composer; `POST /api/assistant/generate` | Offline rule-based helper works without a key; hosted AI is optional and requires provider configuration. |
| Ethereal test sending | Nodemailer worker and SMTP configuration | Implemented for test capture only; not real-recipient delivery. |
| Templates and attachments | — | Not implemented. |
| Automated reply-based follow-ups | — | Not implemented; follow-up emails can be scheduled manually. |
| Open/click tracking | — | Not implemented; requires tracking infrastructure/provider events. |
| Bulk CSV campaigns | — | Not implemented. |

## API overview

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login |
| GET | `/api/emails` | List current user's emails |
| POST | `/api/emails` | Create scheduled email |
| PATCH | `/api/emails/:id` | Edit or reschedule a pending email |
| DELETE | `/api/emails/:id` | Cancel a pending scheduled email |
| POST | `/api/emails/:id/retry` | Retry a failed email |
| GET | `/api/emails/:id/attempts` | Read sending-attempt history |
| POST | `/api/assistant/generate` | Draft or improve email text with the configured provider |
| GET | `/api/analytics` | Current user's delivery summary and seven-day trend |
| GET | `/api/health` | Health check |

All `/api/emails` routes require `Authorization: Bearer <token>`.

Example create request:

```json
{
  "to": "recipient@example.com",
  "subject": "Project update",
  "body": "Hello, this is a scheduled test.",
  "scheduledAt": "2027-01-01T10:00:00.000Z",
  "timezone": "Asia/Kolkata"
}
```

`scheduledAt` is the absolute UTC instant. `timezone` records the IANA timezone used to choose and display that instant.

## Restart test

1. Schedule an email for 2–3 minutes in the future.
2. Confirm it appears in Scheduled.
3. Stop the API and worker.
4. Start Redis (if not already running), then restart API and worker.
5. Confirm the scheduled email remains in SQLite and is re-enqueued.
6. After its due time, confirm status changes to Sent and preview the message using the Ethereal link printed by the worker.

## Assumptions and trade-offs

- SQLite is chosen for easy local setup. For production, use PostgreSQL.
- Redis must be running for BullMQ. The database remains the durable source of truth for scheduled email metadata.
- Ethereal is for development/testing only; use a transactional email provider for real delivery.
- Authentication is a minimal email/password JWT flow. Add email verification, password reset, refresh tokens, and stronger session controls before production.
- Failed jobs are marked failed in SQLite. BullMQ also retries transient failures twice with exponential backoff.
- The sample uses a single queue and one worker entry point; multiple worker processes can be launched with the same Redis connection and queue name.
- A stable job ID and database status check reduce duplicate processing, but cannot guarantee exactly-once SMTP delivery in every crash window.
- Automatic reply-based follow-ups, open tracking, and click tracking are not enabled. Ethereal does not provide the inbound-reply/webhook or tracking integration required to detect those events; follow-ups can be scheduled as separate emails.

## Repository submission

Create a **private** GitHub repository, push this folder, and invite the reviewer account `Mitrajit` as a collaborator (verify the exact GitHub username first). Do not commit `.env`, `node_modules`, SQLite database files, or secrets.
