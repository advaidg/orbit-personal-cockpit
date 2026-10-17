# Pacts, Telegram and Orbit-to-Orbit

Orbit is installed per person — on Railway, a Hostinger VPS, or anywhere that runs Docker. Pacts are how separate installations, and people who have none, still work together.

## Pacts

A **pact** is one promise between you and one other person: *“Maya will send the revised deck by Friday”* or *“I’ll review Dana’s draft by Monday”*.

1. You make a pact (from **Pacts**, from **Waiting On → Make a pact**, from Telegram with `/pact`, or by asking Orbit).
2. Orbit creates a private link and a ready-to-paste message. **Orbit sends nothing.** You send it yourself.
3. The other person opens the link — no account, no app — and taps one of four buttons: *I’m on it*, *It’s done*, *I need more time* (with a date), or *I can’t do this*. The other side gets the mirror image: *This is right*, *I got it*, *Change the date*, *No longer needed*.
4. Orbit updates Waiting On, stops nagging when it is done, and tells you in the app and (if linked) on Telegram.

Rules that keep it honest:

- The person doing the work can move the date. The person who is waiting can only *ask* for a new date; you decide.
- Each pact has one outcome. Once it is done, declined or withdrawn, nothing more can change it.
- Simultaneous taps cannot lose each other’s changes (compare-and-set on a revision counter).

### What the public page can see

Only the promise itself: your display name, what, when, and the page’s own state. Never your email, other pacts, inbox, or anything else. The page sets no cookies, loads no scripts, is marked `noindex`, sends `Referrer-Policy: no-referrer`, and is never cached.

### Link security

- The link is a random 192-bit secret plus the pact id. Only its SHA-256 hash is stored, so a database leak does not leak working links.
- Wrong, expired, revoked and replaced links all return the same “not available” page.
- Links expire after `PACT_LINK_TTL_DAYS` (default 45), can be replaced (**New link**) or turned off at any time, and are rate limited per address and per link.
- Anything typed by the other person is stored as plain text, capped at 280 characters, and always rendered escaped. It is never given to the agent as an instruction.

## Telegram

Open **Connections → Set up Orbit → Telegram**. Create a bot with [@BotFather](https://t.me/BotFather), paste its token (Orbit checks it with Telegram and stores it encrypted), then tap **Link my chat** and press *Start* in Telegram. No redeploy and no webhook.

Orbit long-polls Telegram, so you do **not** need a public webhook. Only one running instance may poll a given bot.

- Only a *private* chat linked with a one-time code (single use, ten minutes, stored hashed) is ever obeyed. Anyone else gets at most one polite refusal a minute.
- Write normally (“who am I waiting on?”) or use `/approvals`, `/waiting`, `/owe`, `/pacts`, `/pact they|me Name | what | when`, `/brief`, `/pause`, `/resume`, `/unlink`.
- Proposals arrive as cards with **Approve** and **Reject** buttons. Approval goes through the same policy engine as the web app, so a paused agent, a prohibited tool or an exhausted limit cannot be approved around. Editing a proposal is only possible in the web app.
- Orbit has no send tool. Nothing in Telegram changes that.

## Orbit to Orbit (optional)

Friends who each run their own Orbit can exchange pacts directly. It is **off** by default because it adds two public endpoints. Turn it on with one switch in **Connections → Set up Orbit → Share pacts** (or `FEDERATION_ENABLED=true`):

- `GET /.well-known/orbit-pacts` — your public key and fingerprint.
- `POST /federation/inbox` — signed messages from installations you trust.

Requirements: `OWNER_EMAIL` and an https `APP_URL` (the switch explains what is missing).

**Trust is explicit and two-way.**

1. In **Pacts → Connections between Orbits**, add your friend’s address. Orbit fetches their key (public addresses only, https only, no redirects).
2. Compare fingerprints out loud or over a channel you already trust, and type theirs to trust them. A request they send you stays *pending* until you do the same.
3. From then on, pacts you address to them arrive in their Pacts page, and each side’s *done / confirm / reschedule / decline* follows on the other.

How messages are protected: every message is signed with an Ed25519 key (the private half is encrypted at rest), addressed to one installation, valid for five minutes, and single-use (replays are ignored). Anything from an unknown, pending or blocked installation looks identical to a bad signature. A peer can hold at most 50 open pacts with you. Their text is plain data, never an instruction to the agent.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PACTS_ENABLED` | `true` | Turns pacts, links and the public page on or off. |
| `PACT_LINK_TTL_DAYS` | `45` | How long a link works. |
| `PACT_MAX_OPEN` | `500` | Most open pacts at once. |
| `TELEGRAM_BOT_TOKEN` | — | Optional: the same as Setup → Telegram. A value saved in Setup wins. |
| `TELEGRAM_INBOUND_ENABLED` | `true` | Set `false` to keep Telegram one-way. |
| `FEDERATION_ENABLED` | `false` | Optional: the same as the Setup switch. A value set in Setup wins. |
| `ORBIT_REPO_URL` | this repo | Where “run your own” on pact pages points. |
