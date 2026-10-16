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
