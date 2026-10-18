# Security policy

Orbit handles sensitive personal information. Please do not report vulnerabilities through public issues.

Until a dedicated security inbox is configured, use GitHub's private vulnerability reporting for this repository.

## Deployment checklist

- Replace both generated secrets in `.env.example` with independent random values.
- Keep `APP_ENCRYPTION_KEY`, OAuth credentials, database URLs, and API keys out of Git.
- Use HTTPS in production.
- Keep Gmail access read-only unless a future feature explicitly requires more.
- Review connected applications periodically in the Google account security settings.
- Back up PostgreSQL before upgrading.

The current project is an early open-source release. Operators should add rate limiting, CSRF protection, audit logging, account deletion/export, and a privacy policy before offering it as a hosted service to untrusted users.

## Public surfaces added with pacts

Three paths accept requests without a dashboard session. Report any weakness in them privately.

- `GET/POST /p/:token` — a capability link to one pact. Secret is 192 bits, stored only as a SHA-256 hash, revocable, expiring and rate limited; it exposes only the promise.
- `GET /.well-known/orbit-pacts` and `POST /federation/inbox` — both return 404 unless `FEDERATION_ENABLED=true`. Messages must be Ed25519-signed by a peer the owner explicitly trusted, addressed to this installation, fresh (five minutes) and unseen.
- Telegram long-polling accepts input only from a private chat linked with a single-use code.

See [docs/PACTS.md](docs/PACTS.md) for the threat model in plain language.

## Orbit Guard

`POST /guard/v1/hook` accepts requests from coding agents, authenticated by a per-agent bearer token (stored only as a hash, revocable, rate limited). Every failure path answers "no opinion", and the only way a risky call is approved is the owner's own tap. Details and limits: [docs/GUARD.md](docs/GUARD.md). Please report any way to make the endpoint approve something it should not, leak a token, or hang the server.
