# Install Orbit

Orbit is a single-tenant application. One installation is intended for one owner. There is no central Orbit account or shared database.

## Railway installation

### 1. Deploy the stack

Deploy the Orbit template, which creates:

- One Orbit application service connected to this GitHub repository.
- One PostgreSQL service with a persistent volume.

Orbit's application container is disposable by design. Persistent records live in PostgreSQL and survive normal application redeploys. Deleting the PostgreSQL service, its volume, the Railway project, or using Orbit's **Delete everything** control removes that data. Configure Railway backups separately if you need point-in-time recovery.
- Independent generated session and encryption secrets.

### 2. Set the owner

Set `OWNER_EMAIL` to the exact Google address permitted to enter this installation. Other Google identities are rejected after OAuth even if the OAuth project permits them.

### 3. Create a Google OAuth application

In a Google Cloud project owned by the installer:

1. Enable Gmail API.
2. Configure the OAuth consent screen. For personal testing, keep it in Testing and add `OWNER_EMAIL` as a test user.
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

Visit `/health` and confirm `ok:true` and `database:postgres`. Then open the home page, continue with Gmail, and run the first sync.

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

## Removal

Use Orbit’s account-deletion operation before destroying an installation when possible; it attempts to revoke provider tokens and deletes the owner record and associated data. Then delete the Railway project or Docker volume to remove the remaining infrastructure and backups under your control.
