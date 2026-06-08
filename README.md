# ScanToGDrive

A lightweight Node.js service that monitors the mailboxes of a Google Group for
emails from a designated sender, extracts attachments, and saves them to each
recipient's Google Drive. It ships with a simple React dashboard for status
monitoring and pause/resume control.

Processing is **forward-looking only** — historical email is never touched.

## How it works

```
            ┌──────────────────────────────────────────┐
            │            Node.js + Express              │
            │                                           │
  Gmail API │  poll loop ──► extract attachments ──►    │ Drive API
  (monitor) │              upload to recipient Drive    │ (upload)
            │                                           │
            │  REST API + WebSocket  ◄── React dashboard│
            └──────────────────────────────────────────┘
```

1. The service uses a **service account with domain-wide delegation**.
2. Every `GMAIL_POLLING_INTERVAL_SECONDS` it lists the members of
   `MONITOR_GROUP_EMAIL` via the Admin SDK Directory API.
3. For each member it impersonates that mailbox and searches Gmail for new mail
   from `MONITOR_SENDER_EMAIL` (`from:… after:<boot-watermark> has:attachment`).
4. Attachments are decoded and uploaded to a folder (`DRIVE_FOLDER_NAME`) in the
   recipient's own Drive, again via impersonation.
5. Message IDs are de-duplicated and persisted so nothing is processed twice.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/config.js` | Environment configuration + validation |
| `src/auth.js` | Service-account / domain-wide delegation clients |
| `src/group.js` | Google Group membership (Admin SDK, cached) |
| `src/gmail.js` | Gmail search, message + attachment fetch, MIME parsing |
| `src/drive.js` | Drive folder management + uploads (dedupe filenames) |
| `src/processor.js` | The polling monitor / orchestration loop |
| `src/state.js` | Pause flag, dedupe set, stats, restart recovery (JSON file) |
| `src/logger.js` | Structured JSON logging + in-memory ring buffer |
| `src/routes.js` | REST API (`/api/*`) |
| `src/index.js` | Express server + WebSocket log stream |
| `public/` | React dashboard (no build step — CDN React) |

## Google Workspace setup

1. **Create a Google Cloud project** and enable the **Gmail API**, **Google
   Drive API**, and **Admin SDK API**.
2. **Create a service account** and generate a JSON key.
3. **Enable domain-wide delegation** on the service account. In the Google
   Workspace Admin console (Security → API controls → Domain-wide delegation),
   add the service account's client ID with these scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/admin.directory.group.member.readonly`
4. Set `GOOGLE_ADMIN_EMAIL` to a super-admin the service account may impersonate
   for group-membership lookups.
5. Put all monitored mailboxes into the Google Group named by
   `MONITOR_GROUP_EMAIL`.

> The Admin SDK scope is required to enumerate / verify group membership. It is
> read-only and is the minimum needed for that capability.

## Configuration

Copy `.env.example` to `.env` and fill it in. Key variables:

| Variable | Description |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Path to JSON, raw JSON, or base64 JSON |
| `GOOGLE_ADMIN_EMAIL` | Super-admin to impersonate for the Admin SDK |
| `MONITOR_SENDER_EMAIL` | Only mail from this sender is processed |
| `MONITOR_GROUP_EMAIL` | Group whose members are monitored |
| `GMAIL_POLLING_INTERVAL_SECONDS` | Poll cadence (default 60) |
| `DRIVE_FOLDER_NAME` | Destination folder (default "Email Attachments") |
| `DRIVE_MAX_FILE_SIZE_BYTES` | Skip attachments above this size |
| `DASHBOARD_API_KEY` | Shared secret protecting the dashboard/API |

## Running locally

```bash
npm install
cp .env.example .env   # then edit
npm start              # http://localhost:8080
npm test               # unit tests for the pure logic
```

Open the dashboard at `http://localhost:8080`. If `DASHBOARD_API_KEY` is set you
will be prompted for it.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/status` | Running/paused state, config summary, counters |
| `GET` | `/api/stats` | Counters only |
| `GET` | `/api/logs?level=&search=&limit=` | Recent logs |
| `POST` | `/api/pause` | Pause processing |
| `POST` | `/api/resume` | Resume processing |
| `GET` | `/healthz` | Unauthenticated health check |
| `WS` | `/ws/logs` | Live log stream |

All `/api/*` routes and the WebSocket require the `x-api-key` header (or
`?apiKey=`) when `DASHBOARD_API_KEY` is set.

## Deployment on DigitalOcean

### App Platform (simplest)

Use `.do/app.yaml`. Set the secret env vars in the dashboard. Note: App
Platform's filesystem is **ephemeral**, so `STATE_FILE_PATH` does not survive
redeploys — this is safe because the forward-looking watermark resets to the
new boot time, so no historical mail is reprocessed (at most an in-flight email
from the seconds around a restart could be re-handled; duplicate filenames are
handled gracefully).

### Droplet (persistent state)

Install Node 20+, clone the repo, `npm install --omit=dev`, and run under
`pm2` or `systemd`. Mount a volume for `./data` so the dedupe set / pause flag
survive restarts. Front it with nginx for TLS.

```bash
pm2 start src/index.js --name scan-to-gdrive
pm2 save && pm2 startup
```

## Error handling

- **Recipient not in group** — only group members are polled; a sender mismatch
  on a fetched message is logged and skipped.
- **Attachment too large** — logged as ERROR and skipped; other attachments in
  the same email continue.
- **Transient API failures** — exponential backoff (1s, 2s, 4s, 8s).
- **Gmail quota exceeded** — polling pauses for 24h, then resumes automatically.
- **Service crash** — restart resumes from a fresh forward-looking watermark;
  persisted dedupe set prevents reprocessing recent messages.

## Security notes

- Store the service account JSON as a DigitalOcean secret (base64).
- Domain-wide delegation is scoped to the three minimal scopes above.
- Sender and group membership are both validated before any upload.
- Email bodies and attachment contents are never logged.
- Set `DASHBOARD_API_KEY` to protect pause/resume in production.
