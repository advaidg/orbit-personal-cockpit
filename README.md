<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/orbit-lockup-dark.svg">
  <img src="public/brand/orbit-lockup-light.svg" alt="Orbit — Everything important. Nothing noisy." width="620">
</picture>

# Orbit

**Everything important. Nothing noisy.**

Brand assets and usage guidance are available in [`public/brand`](public/brand/BRAND.md).

Orbit is an open-source personal operations cockpit. It turns the scattered signals in your inboxes, calendars, tasks, and work tools into one calm daily brief: what changed, what needs you, what you are waiting on, and what can safely wait.

Gmail is the first working connector, not the product boundary. The source model is designed for multiple Gmail accounts, Outlook, calendars, GitHub, Slack, finance alerts, travel, and manual capture.

## Why this is different

Most dashboards show more data. Orbit makes fewer demands on your attention.

- **One brief, many sources** — normalize messages, events, reviews, alerts, and reminders into a shared signal model.
- **A focus queue, not another inbox** — AI promotes only items that need a decision or action.
- **Waiting-on memory** — keep track of commitments other people owe you.
- **Quiet by default** — newsletters and passive updates are measured as noise filtered, not work created.
- **Honest before setup** — a guided connection screen appears until real sources are connected; sample data is explicitly opt-in.
- **Self-hostable** — PostgreSQL, encrypted OAuth tokens, a Dockerfile, and Railway configuration are included.

## Current MVP

- Responsive personal cockpit with AI daily brief
- Multiple Gmail account connection model
- Gmail OAuth with read-only scope and encrypted refresh tokens
- Installation-local dashboard password for returning browsers; Gmail remains a connector and recovery path
- Owner-controlled auto-sync interval, first-sync history/limits, Gmail category exclusions, and sender/keyword filters; `SYNC_CRON` controls the scheduler wake-up
- AI classification into action, waiting, calendar, money, travel, people, and noise
- OpenAI API, Anthropic API, OpenAI-compatible models, and eligible ChatGPT plan usage with a private rules-only mode
- Focus queue with manual capture and completion
- Visible per-connection sync errors plus safe clear-and-reprocess after changing AI providers
- Owner-visible activity and diagnostics timeline with plain-language next steps; no message bodies, prompts, tokens, or AI answers are logged
- PostgreSQL in production; zero-setup in-memory demo locally
- Health check and production Docker image

## Agent (new)

Orbit now proposes work instead of only showing it: draft replies, waiting-on tracking, deadlines, reminders, automations and calendar suggestions, all through an Approval Center. See [docs/AGENT.md](docs/AGENT.md) for the safety model, limits and environment controls.

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. Set `DEMO_MODE=true` only if you explicitly want the visibly labeled sample workspace. Otherwise Orbit starts empty and waits for real sources. The API runs on port 3000.

For a production-like local install with PostgreSQL:

```bash
cp .env.example .env
docker compose up --build
```

Then open `http://localhost:3000`.

To connect Gmail, create a Google OAuth 2.0 **Web application**, enable the Gmail API, and add this redirect URI:

```text
http://localhost:3000/auth/google/callback
```

Then populate `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

## Deploy to Railway

1. Push this repository to GitHub.
2. In Railway, create a project from the repository.
3. Add a PostgreSQL service. Railway injects `DATABASE_URL` automatically.
4. Generate a public domain for the Orbit service.
5. Set the variables from `.env.example`, with `APP_URL` set to the Railway domain and `OWNER_EMAIL` set to the only Google account allowed into the installation.
6. Add `https://YOUR-DOMAIN/auth/google/callback` to the Google OAuth client.

Railway detects the root `Dockerfile`; `/health` is configured as the deployment health check.

On the first visit, use Gmail once to establish the owner and connector. Then open **Settings → Dashboard password** and create a password of at least 12 characters. New browsers can unlock Orbit with that local password without repeating Google sign-in; Google OAuth remains available for reconnecting Gmail or recovery.

Complete instructions are in [docs/INSTALL.md](docs/INSTALL.md). Every installation exposes public `/privacy`, `/terms`, and `/security` pages for Google OAuth configuration while keeping the dashboard itself owner-only.

For a public one-click template, follow [the template publishing checklist](docs/RAILWAY_TEMPLATE.md) after the GitHub repository is public. Railway assigns the final template code, which can then be added as a Deploy button here.

## Product roadmap

The detailed product thesis—including Waiting On, People, Life Admin, decision packets, personal rules, and the connector sequence—is in [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md).

| Layer | Next connectors | What Orbit extracts |
| --- | --- | --- |
| Communication | Outlook, Slack, Teams | requests, decisions, waiting-ons |
| Time | Google Calendar, Outlook Calendar | conflicts, preparation, travel buffers |
| Work | GitHub, Linear, Jira | reviews, blockers, releases |
| Life admin | receipts, bills, travel email | due dates, changes, recurring costs |
| Knowledge | Drive, Notion | related context for each decision |

The long-term idea is a private, portable attention layer—not a replacement for the tools where the work happens.

See [AI providers](docs/AI_PROVIDERS.md), [ChatGPT plan setup](docs/CHATGPT_SUBSCRIPTION.md), and [data and privacy](docs/DATA_AND_PRIVACY.md) for the complete operating model.

## Security posture

- Gmail requests `gmail.readonly`; Orbit does not send or delete email.
- OAuth tokens are encrypted with AES-256-GCM before persistence.
- Imported ChatGPT OAuth credentials are installation-bound, encrypted before persistence, refreshed server-side, and revocable from Settings.
- Application data lives in PostgreSQL, not the disposable application container, so normal Railway builds and redeploys do not remove accounts, connections, tasks, signals, briefs, or settings.
- AI provider selection and excerpt limits are stored per owner in PostgreSQL; provider credentials remain server-side environment variables.
- `APP_ENCRYPTION_KEY` and `SESSION_SECRET` must be unique production secrets.
- API credentials never ship to the browser.
- `OWNER_EMAIL` makes the default deployment single-tenant and rejects other Google identities.
- The optional dashboard password is stored only as a salted scrypt hash; plaintext is never persisted.
- Account export omits encrypted credentials; disconnect and deletion attempt provider-token revocation.
- Raw email bodies are processed transiently and are never stored in PostgreSQL.
- Normalized signals expire after `SIGNAL_RETENTION_DAYS` (30 by default).
- `AI_PROVIDER=rules` keeps message content away from external AI providers.
- The owner dashboard uses a signed, expiring, secure HTTP-only session; mutations are origin-checked and rate-limited.

## Contributing

The cleanest contribution is a new source adapter that emits Orbit `Signal` objects. Start with `server/types.ts`, keep permissions minimal, and make every connector useful without requiring AI.

MIT licensed.
