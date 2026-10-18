# Launch post drafts

Edit freely. Keep the honest parts; they are what make people trust it.

## LinkedIn

I built a personal AI agent that you run in your own cloud, and it does one thing other agents don't: it keeps promises *between people*.

Most agent demos end with "it did a task for me." But what actually slips through the cracks isn't tasks. It's "I'll send it Friday."

Orbit turns a promise into a pact: a private link the other person opens with no account and answers in one tap (on it / done / need more time / can't). Orbit updates your Waiting On list, stops nagging when it's done, and pings you on Telegram. If your friend runs their own Orbit, the two installs exchange pacts directly with signed messages, no middleman server.

The part I care most about: it asks before it acts. Every proposal shows what changes and what leaves your server. It writes Gmail drafts but has no code path that sends email. Everything it "learns" is a plain sentence you can edit.

It's open source (MIT), self-hosted on Railway, a $5 VPS or Docker, with 288 automated tests. Early software, so try it on a throwaway Gmail first.

Repo: https://github.com/advaidg/orbit-personal-cockpit

I'd love to know what you'd want it to keep track of.

## Reddit (r/selfhosted, r/SideProject)

**Title:** Orbit: a self-hosted personal agent that tracks promises between people (open source, asks before it acts)

I got tired of agents that "do things for me" with no way to see or stop what they're doing, so I built one with the opposite defaults.

- Self-hosted: Railway, any VPS with Docker + Caddy (automatic HTTPS compose file included), or `docker compose` at home. Postgres, no telemetry, ~116 KB of JS.
- Reads Gmail/Calendar, finds promises and deadlines with deterministic rules, drafts replies into your Drafts folder. **There is no send code path.** (Google has no draft-only scope, so the consent screen technically covers sending. The code just doesn't do it.)
- Approval Center: every action shows what changes, why, and what leaves your server. Pause switch, env-level ceilings, undo.
- Telegram: chat with it, approve with buttons. Long-polling, so no webhook. And the whole setup (bot, email, AI keys, sharing) happens in the UI: no env vars, no redeploy.
- The unusual part, **pacts**: turn a promise into a private link; the other person answers in one tap with no account. Orbit-to-Orbit sharing uses Ed25519-signed messages and explicit two-way trust.
- Works with no AI provider at all (rules mode), or OpenAI / Anthropic / any OpenAI-compatible endpoint.

Honest status: early. 288 tests (memory + Postgres), but the Google/Telegram integrations are tested through fakes, so use a throwaway account first. Feedback and bug reports very welcome.

https://github.com/advaidg/orbit-personal-cockpit
