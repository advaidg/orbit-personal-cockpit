# Install Orbit

Orbit is a single-tenant application. One installation is intended for one owner. There is no central Orbit account or shared database.

## Railway installation

### 1. Deploy the stack

Deploy the Orbit template, which creates:

- One Orbit application service connected to this GitHub repository.
- One PostgreSQL service with a persistent volume.

Orbit's application container is disposable by design. Persistent records live in PostgreSQL and survive normal application redeploys. Deleting the PostgreSQL service, its volume, the Railway project, or using Orbit's **Delete everything** control removes that data. Configure Railway backups separately if you need point-in-time recovery.
- Independent generated session and encryption secrets.

On Railway you can leave `APP_URL` empty: Orbit reads the public domain Railway assigns. (Set it yourself if you use a custom domain.)

### 2. Set the owner

Set `OWNER_EMAIL` to the exact Google address permitted to enter this installation. Other Google identities are rejected after OAuth even if the OAuth project permits them.

### 3. Create a Google OAuth application

In a Google Cloud project owned by the installer:

1. Enable Gmail API.
2. Configure the OAuth consent screen (User type: External) and add `OWNER_EMAIL` as a test user. **Then press “Publish app” to move it from *Testing* to *In production*.** This matters: while an app is in Testing, Google expires its sign-ins after **7 days**, so Gmail sync would quietly stop every week. Publishing does not make Orbit public — `OWNER_EMAIL` still locks the installation to you, and Google only shows an *“unverified app”* warning once when you connect (choose *Advanced → Go to your app*). That warning appears because Google has not reviewed *your* private app, which is expected for a self-hosted install.
3. Create an OAuth client of type Web application.
4. Add `https://YOUR_ORBIT_DOMAIN/auth/google/callback` as an authorized redirect URI.
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the Orbit service.

Use these public URLs in the Google consent-screen configuration:

- Homepage: `https://YOUR_ORBIT_DOMAIN/`
- Privacy policy: `https://YOUR_ORBIT_DOMAIN/privacy`
- Terms: `https://YOUR_ORBIT_DOMAIN/terms`

### 4. Choose intelligence mode

Start with `AI_PROVIDER=rules`; it requires no AI account and transmits no message content to an AI provider. See [AI_PROVIDERS.md](AI_PROVIDERS.md) before enabling an external provider.

### 5. Verify

Visit `/health` and confirm `ok:true` and `database:postgres`. Then open the home page and continue with Gmail once to establish the owner and connector.

Open **Settings → Dashboard password** and set a password of at least 12 characters. Orbit stores only a salted scrypt hash in PostgreSQL. From then on, a new browser can unlock the dashboard with that password; Gmail sign-in is no longer required for each browser. Keep Google OAuth available as the Gmail reconnection and recovery path.

If Activity reports that Gmail permission is incomplete, disconnect Gmail and connect it again, approving the requested read-only Gmail permission. This one-time reconnection is required when upgrading an older credential that was issued without the Gmail scope.

In **Settings → Sync schedule & inbox rules**, choose how far back the first import should read, cap the number of messages, exclude Gmail Promotions/Social/Forums, and add sender or keyword filters. Auto-sync can be paused without disconnecting Gmail; **Sync now** remains available. If you later change AI providers, use the explicitly confirmed **Clear & re-sync** operation to rebuild normalized signals, the brief, and email-generated tasks while preserving connections and manual tasks.

The **Activity & diagnostics** panel keeps the latest 200 operational events per owner. It records counts, provider names, outcomes, and plain-language recovery suggestions—not email bodies, questions, AI answers, OAuth tokens, or secrets. The owner can clear the log independently of other data.

## Docker installation

```bash
git clone https://github.com/advaidg/orbit-personal-cockpit.git
cd orbit-personal-cockpit
cp .env.example .env
```

Generate independent secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Place one value in `SESSION_SECRET` and the other in `APP_ENCRYPTION_KEY`, configure `OWNER_EMAIL` and Google credentials, then run:

```bash
docker compose up --build -d
```

Open `http://localhost:3000`.

## VPS installation (Hostinger, Hetzner, DigitalOcean, any Docker host)

You need a VPS with Docker and a domain whose DNS points at it.

```bash
git clone https://github.com/advaidg/orbit-personal-cockpit.git
cd orbit-personal-cockpit
cp .env.example .env
npm run secrets            # or: node scripts/gen-secrets.mjs — paste both lines into .env
```

In `.env` set `DOMAIN=orbit.example.com`, `APP_URL=https://orbit.example.com`, `POSTGRES_PASSWORD` (any long random value), `OWNER_EMAIL`, and your Google credentials. Add `https://orbit.example.com/auth/google/callback` as an authorized redirect URI in Google Cloud. Then:

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

Caddy obtains and renews the HTTPS certificate on its own, and only ports 80 and 443 are exposed. Updating is `git pull` then the same command.

### Optional extras: do them in the app

Telegram chat, email digests, AI provider keys and Orbit-to-Orbit sharing are all set up in **Connections → Set up Orbit**, with no environment variables and no redeploy. Saved secrets are encrypted with `APP_ENCRYPTION_KEY`. See [PACTS.md](PACTS.md).

## Removal

Use Orbit’s account-deletion operation before destroying an installation when possible; it attempts to revoke provider tokens and deletes the owner record and associated data. Then delete the Railway project or Docker volume to remove the remaining infrastructure and backups under your control.
