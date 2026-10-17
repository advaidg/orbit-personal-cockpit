# Orbit agent

Orbit observes your sources, remembers what matters, **proposes** work, acts only with permission, verifies the result, and keeps a plain-language record.

## Safety model

| Action | Default |
|---|---|
| Read connected data | Allowed after you authorize the connector |
| Classify / summarize | Automatic |
| Local task, reminder, memory change | Asks (set `ACTION_APPROVAL_DEFAULT=external` or add an "always allow" rule to relax) |
| Gmail draft | Asks; needs "Read plus create drafts" |
| Calendar event | Always asks; private event, no invitations |
| Send email / message | Not possible: Orbit has no send tool |
| Delete provider data | Always asks (only owner-pressed Undo removes a draft/event Orbit created) |
| Purchases, shell commands | Prohibited |
| Install / enable skills | Always asks |

Environment variables set the installation's maximum. The UI can only be stricter. **Pause agent** stops schedules, automations and every write without disconnecting sources.

> Google has no draft-only Gmail scope: `gmail.compose` also permits sending. Orbit's code has no send path, and its Gmail gateway exposes only read-headers and draft create/get/delete/find.

## Architecture

connectors → signals → planner (rules, or a model that can only request typed tools) → **policy** → approval → durable job → tool → **verify** → run log.
Model output is validated against typed tool schemas, ownership-checked, previewed, and policy-gated. Email text is always data, never instructions; recipients come from provider headers, never from model output.

- Durable PostgreSQL job queue: retries with backoff, idempotency keys, stale-job recovery after redeploys, cancel.
- Versioned migrations (`schema_migrations`), applied under an advisory lock.
- Idempotent proposals: the same signal never produces a second draft/task, even after "Clear & re-sync".

## What Orbit stores about mail
Signals (title, short summary, sender, thread/header ids), commitments with a ≤200-character evidence excerpt, and proposals. Raw bodies are never stored.

## Railway configuration migration
Railway is deprecating `railway.json` in favour of `.railway/railway.ts` (hard cutoff reported as 2026-12-01). This needs your authenticated project, so it has not been applied. From a clone, logged in with the Railway CLI:

```bash
railway config migrate        # preview
railway config plan           # review the diff
railway config migrate --apply
```
Migrate each service once; do not leave a service managed by both systems.

## Tests
`npm test` (in-memory) and `npm run test:pg` (needs Postgres on `localhost:54329`; see `package.json`). CI runs both.
