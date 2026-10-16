# Publishing the Orbit Railway template

The repository already contains the production `Dockerfile`, health check, and config-as-code file. Railway template creation still requires the maintainer's Railway workspace because Railway assigns the shareable template code.

## Recommended template canvas

Create two services:

1. **Orbit** — source: this public GitHub repository; HTTP networking enabled; health check `/health`.
2. **Postgres** — Railway's official PostgreSQL template.

Configure these Orbit variables:

| Variable | Template value |
| --- | --- |
| `DATABASE_URL` | reference the Postgres service's `DATABASE_URL` |
| `APP_URL` | reference Orbit's public URL |
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | `${{secret(64, "abcdef0123456789")}}` |
| `APP_ENCRYPTION_KEY` | `${{secret(64, "abcdef0123456789")}}` |
| `SYNC_CRON` | `*/30 * * * *` |
| `DEMO_MODE` | `true` |
| `GOOGLE_CLIENT_ID` | prompt the deployer |
| `GOOGLE_CLIENT_SECRET` | prompt the deployer |
| `OPENAI_API_KEY` | optional prompt |

After deploying the project successfully:

1. Open project settings and choose **Generate Template from Project**.
2. Confirm both services, variables, public networking, and the health check.
3. Create and publish the template in the **AI/ML** or **Automation** category.
4. Copy the assigned template URL.
5. Add the official button to `README.md`:

```md
[![Deploy on Railway](https://railway.com/button.svg)](YOUR_TEMPLATE_URL)
```

6. Add the live demo project in the template settings once the public demo is stable.

Before announcing on Reddit, test the template in a clean Railway workspace and verify that a new deployer can reach demo mode before adding Google credentials.
