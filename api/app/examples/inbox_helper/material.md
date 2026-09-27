# Inbox Helper: design notes

Inbox Helper connects to a user's Gmail account and uses an AI agent to triage mail, summarize threads and draft replies.

## Components

- **Web app**: React single page app. Users sign in with Google.
- **API**: FastAPI service on Fly.io. Handles sessions, stores settings and serves summaries.
- **Mail sync worker**: polls the Gmail API every two minutes with each user's OAuth refresh token, saves new messages to Postgres and queues a triage job.
- **Triage agent**: built on the OpenAI API. For each new thread it reads the messages and earlier mail, writes a summary and a suggested label, and can call tools:
  - `send_email(to, subject, body)` so users can say "forward receipts to my accountant"
  - `fetch_url(url)` to read the links in an email before summarizing it
  - `search_mail(query)` to look up earlier threads
- **Postgres** on Supabase: users, OAuth refresh tokens (encrypted with a key from an environment variable), message bodies and summaries.
- **Redis**: the job queue between the sync worker and the agent.

## Flows

- The user signs in with Google. The API exchanges the code for a refresh token and stores it.
- The sync worker reads refresh tokens from Postgres, pulls new mail from Gmail and writes messages to Postgres.
- The agent reads the thread and earlier mail from Postgres, calls the OpenAI API and writes the summary back.
- When a reply is needed, the agent calls send_email through the Gmail API. Auto-send is on by default for replies under 50 words.
- fetch_url makes an outbound HTTP request to any URL found in an email.
- The web app shows summaries and drafts rendered as Markdown.

## Notes

- Anyone can email a user, so message bodies are untrusted.
- The admin dashboard at /admin uses the same session cookie, guarded by an `is_admin` flag.
- Logs go to Better Stack, including full agent prompts for debugging.

## Code layout

- `web/src/auth/GoogleSignIn.tsx` line 12: starts the Google sign-in with `@react-oauth/google` and posts the code to `/auth/google`.
- `web/src/inbox/Summary.tsx` line 31: renders summaries and drafts with `react-markdown`.
- `api/app/routes/auth.py` line 44: `google_callback` exchanges the code for tokens with `google-auth-oauthlib` and sets a signed session cookie.
- `api/app/routes/admin.py` line 17: the /admin dashboard, allowed when `user.is_admin` is true.
- `api/app/crypto.py` lines 21 and 30: `encrypt_token` and `decrypt_token` use Fernet (AES-128-CBC with HMAC-SHA256) with `TOKEN_KEY` from the environment.
- `worker/sync.py` line 38: `poll_inbox` runs on an APScheduler interval of 120 seconds, calls `users.history.list` since the last `historyId`, and enqueues `triage_thread` with RQ.
- `agent/triage.py` line 52: `triage_thread` loads the thread and the 20 most recent related messages, then runs a tool-calling loop with `gpt-4o` for up to 5 steps.
- `agent/tools.py` lines 14, 41 and 67: `send_email`, `fetch_url` (with `httpx`, following redirects) and `search_mail` (Postgres full-text search).
- `agent/logging.py` line 9: sends every prompt and reply to Better Stack with `logtail-python`.
