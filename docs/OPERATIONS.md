# Running Orbit

Everything you need once Orbit is installed: updating, backing up, rotating secrets, and fixing the common problems.

## Updating

- **Railway:** Orbit redeploys whenever the branch you deployed from changes. Pull upstream changes into your fork and push.
- **VPS or Docker:** `git pull`, then `docker compose -f docker-compose.vps.yml up -d --build` (or `docker compose up -d --build` for the local file).

Database changes are applied automatically at startup, in order, under a lock, and they only ever **add** tables or columns. A redeploy never removes your data, and rolling back to an older version still works.

## Backups

Everything Orbit stores is in PostgreSQL. Back that up.

```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom > orbit-$(date +%F).dump     # backup
pg_restore --no-owner --clean --dbname "$DATABASE_URL" orbit-2026-10-17.dump      # restore
```

A dump contains **encrypted** credentials. It is only readable with the same `APP_ENCRYPTION_KEY`, so back that key up separately (a password manager is fine) and never store it beside the dump.

Separately, **Settings → Your data → Download JSON export** gives you a readable copy of your signals, tasks, pacts and settings with every credential left out.

## Secrets

| Secret | If you change it |
| --- | --- |
| `SESSION_SECRET` | Everyone is signed out once. Nothing else is affected. |
| `APP_ENCRYPTION_KEY` | Saved Google connections, the ChatGPT connection, and everything entered in **Set up Orbit** (bot token, email login, AI keys) become unreadable. Orbit logs which ones and carries on; reconnect them. Don't rotate this casually. |
| Dashboard password | **Settings → Dashboard password**. |
| Telegram bot token | Paste a new one in **Set up Orbit → Telegram** (this unlinks the old chat; link again). |

## Health

- `/health` answers `{"ok":true}`; Railway and Docker use it.
- **Connections → Diagnostics** shows database, Gmail, Calendar, Telegram, Orbit-to-Orbit, the job queue and the scheduler, with a plain-language "next step" for anything failing.
- **Runs → Background jobs** lists recent jobs with sanitized failure reasons.

## When something is wrong

| What you see | Why, and what to do |
| --- | --- |
| Gmail stops syncing about a week after you connected it | Your Google app is still in *Testing*, where Google expires sign-ins after 7 days. In Google Cloud → OAuth consent screen, press **Publish app** (it stays private to you), then reconnect Gmail once. |
| "Not authenticated" right after signing in, or sign-in loops | `APP_URL` doesn't match the address in your browser, or isn't `https://` in production. On Railway you can leave it empty. |
| Pact links point at `localhost` | `APP_URL` is wrong or unset. Set it to your public `https://` address and redeploy. |
| Telegram: "another copy is polling this bot" | Two running copies of Orbit share one bot token (for example a local one and the deployed one). Stop one, or give each its own bot. |
| Telegram stops answering | **Diagnostics → Telegram** shows why. A rejected token means you regenerated it in BotFather: paste the new one. |
| Orbit-to-Orbit: "Not delivered" | The other Orbit is offline, or one of you doesn't trust the other yet. It retries automatically; check both sides in **Pacts → Connections between Orbits**. |
| Saved settings vanish after a restart | There is no database attached, so Orbit runs in memory. Add PostgreSQL. |
| Email test fails | Gmail needs an **app password** (Google Account → Security → 2-Step Verification → App passwords), not your normal password. |
| An AI provider says "rejected the key" | Copy the whole key again; make sure it is active and has credit. |

## Removing everything

Use **Settings → Delete this account** first (it revokes Google access and erases your records), then delete the Railway project, or `docker compose down -v` to remove the database volume.
