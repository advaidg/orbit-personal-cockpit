# Launch post drafts

Edit freely. Keep the honest parts; they are what make people trust it. Record a 20-second clip first (an agent tries `git push --force`, the phone buzzes, you tap Deny, the log shows it) and attach it to everything below.

## Hacker News (Show HN)

**Show HN: Orbit Guard, a self-hosted permission layer for Claude Code (phone approvals, budgets, audit log)**

I got tired of two bad options with coding agents: click "allow" a hundred times a day until I stopped reading the prompts, or turn the prompts off and hope. Orbit Guard sits behind Claude Code's PreToolUse hook and applies a policy instead: reads, tests, `git status` and in-project edits pass silently; force-pushes, `rm -rf`, deploys, reading `.env`, and sending data to outside servers wait for a tap on my phone with the exact command and a plain reason; `rm -rf /` and friends are refused outright.

It also records every call (secrets redacted, file contents never stored), enforces a daily token budget per agent, and sends an evening summary of what ran and what it asked me about.

Details I care about: if Orbit is unreachable the hook falls back to Claude Code's own prompt (an outage never becomes "allow"); a command is judged by its worst part, so `ls && git push --force` and `$(rm -rf x)` don't slip through; "always allow this here" stores a hash, not the command; allow rules can't be a bare wildcard and never cover chained commands.

What it is not: a sandbox. It's a safety net for overeager agents and honest mistakes. Command analysis is heuristic, and I've tested it with simulated hook events and the real hook program against a running server, not yet across many Claude Code versions. Feedback on what it misses is the most useful thing you could give me.

Self-hosted (Railway / a VPS with the included Caddy compose file / Docker), MIT, ~430 tests. https://github.com/advaidg/orbit-personal-cockpit

## LinkedIn

I used to approve Claude Code's permission prompts without reading them. Then I realised that means I wasn't really approving anything.

So I built Orbit Guard: a self-hosted permission layer that sits between a coding agent and your machine.
• Safe calls (reads, tests, in-project edits) pass silently.
• Risky ones (force-push, deploys, rm -rf, reading .env, sending data out) buzz my phone with the exact command and a plain-English reason. One tap: approve, always allow here, or deny.
• Catastrophic ones are refused outright.
• Everything is logged, with a daily token budget and an evening summary: "214 calls, 198 silent, 14 needed you, 2 refused."

It's open source, runs on your own server, and fails safe: if it's down, Claude Code just asks you itself.

It's a safety net, not a sandbox, and I say so in the README. Early software: I'd love to hear what it should have caught.

Repo: https://github.com/advaidg/orbit-personal-cockpit

## Reddit (r/ClaudeAI, r/selfhosted, r/LocalLLaMA, r/programming)

**Title:** I built a self-hosted "approval fatigue" fix for Claude Code: silent for safe calls, phone approval for risky ones

Body: lead with the 20-second clip, then the three bullets above, then the honest limits (not a sandbox; heuristic analysis; Claude Code only today; tested with simulated events plus the real hook program). Ask: "what would you want it to catch or let through that it currently doesn't?" Reply to every comment for the first two days.

## Also worth a line

Orbit's original side: *pacts*, private links the other person answers in one tap with no account, plus Telegram chat and Orbit-to-Orbit sharing. Mention it as "the same approval engine also runs a personal-ops agent", but lead with Guard.
