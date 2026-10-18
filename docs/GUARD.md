# Orbit Guard — a permission layer for coding agents

Coding agents ask "can I run this?" hundreds of times a day. People start clicking Yes without reading, or switch the prompts off, which hands an agent the keys to their machine. Orbit Guard replaces that with a policy that makes sense:

- **Safe things pass silently.** Reading files, `git status`, running your tests, editing inside the project.
- **Dangerous things wait for you.** Your phone buzzes with the exact command, the project, and a plain reason. Tap *Approve*, *Always allow this here*, or *Deny*.
- **Catastrophic things are refused outright.** `rm -rf /`, formatting a disk, fork bombs. No rule can override this.
- **Everything is recorded.** A readable log of every call, what Orbit decided and why, plus a daily token budget and an evening summary.

It runs inside your own Orbit installation. Nothing is sent to anyone else.

## What it is, and what it isn't

Orbit Guard is a **safety net for overeager agents and honest mistakes**. It is **not a sandbox**. A determined, malicious process can find ways around any command filter. If you need isolation, run the agent in a container or VM as well; Orbit Guard then gives you the approval flow and the audit trail on top.

It covers what the agent asks to do through its tool-call hook (shell commands, file reads and writes, web fetches, extension tools). It does not see what a script does *after* it starts, which is why running unknown scripts is rated "not known to be safe".

## Try it first

Every Orbit serves a public, client-side playground at `/playground.html`. Type a command (or pick a file to read or edit), choose a strictness, and see exactly what Orbit Guard would do, with a per-command breakdown of how it was read. Nothing leaves your browser, and results have shareable links. The same classifier code runs on the server, so the playground and the real thing agree.

## Setup (about two minutes)

1. Open **Agents** in Orbit, name your agent, and press **Create access token**. Copy it now: Orbit stores only a fingerprint.
2. Download the hook onto the machine where you run Claude Code, and set two variables (Orbit shows the exact lines, with your address filled in):

   ```bash
   mkdir -p ~/.orbit && curl -fsSL https://YOUR-ORBIT/guard/hook.mjs -o ~/.orbit/orbit-guard.mjs
   export ORBIT_URL=https://YOUR-ORBIT
   export ORBIT_GUARD_TOKEN=og_...
   ```

3. Merge this into `~/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node ~/.orbit/orbit-guard.mjs", "timeout": 210 }] }
       ]
     }
   }
   ```

4. Link Telegram in **Connections → Set up Orbit** so approvals reach your phone (or keep the **Agents** page open: waiting requests appear there too).

Start a new Claude Code session. Try the **What would Orbit do?** box on the Agents page first if you want to see how it judges a command, without running anything.

The hook needs Node 18 or newer, which Claude Code users almost always have.

### If Orbit can't be reached

The hook hands control back to Claude Code's own permission prompt, exactly as if Orbit weren't there. It never turns an outage into "allow". If you would rather it refuse, set `ORBIT_GUARD_FAIL=deny`.

## How a call is judged

Orbit splits a shell command into the commands it would actually run (so `ls && git push --force` is judged by its worst part, and `$(...)` and backticks can't hide anything), strips wrappers like `sudo` and `env`, and rates each one.

| Rating | What happens | Examples |
| --- | --- | --- |
| **Refused** | Blocked at once, no prompt | `rm -rf /`, `rm -rf ~`, `mkfs`, `dd` to a disk, fork bombs |
| **Needs you** | Held until you answer | `rm`, `git push --force`, push to `main`, `git reset --hard`, deploys (`vercel --prod`, `kubectl apply`, `terraform apply`, `railway up`), `npm publish`, `docker push`, reading or writing `.env` / SSH keys / cloud credentials, `curl -d` to an outside server, `curl \| sh`, `sudo`, writing outside the project, editing CI workflows or shell profiles, SQL that drops or deletes, commands written to hide what they do |
| **Not known** | Depends on your strictness | An unrecognised program, `npm install some-package`, a plain `git push`, extension (MCP) tools, fetching a web page |
| **Safe** | Passes silently | `ls`, `cat`, `git status/diff/log`, `grep`, `npm test`, `npm run build`, `tsc`, `pytest`, `cargo test`, read-only `docker`/`kubectl`/`gh`, editing files inside the project |

**Strictness** decides what happens to *not known*:

- **Relaxed:** runs. Only the dangerous things stop.
- **Balanced** (default): hands back to the agent's own prompt, so you don't get a phone buzz for every unknown command.
- **Strict:** asks your phone.

## Rules

On the Agents page you can add your own rules. They run before the built-in judgement, and **deny beats ask beats allow**.

- A rule matches a **tool** (`Bash`, `Edit`, ...), and either a **pattern** (`npm run deploy*`; `*` is the only wildcard) or an **exact** command or path, optionally only in one project folder.
- **Always allow this here**, on a phone card, creates an exact rule for that one command in that one project. The command itself is stored only as a hash.
- Safeguards: an allow rule can't be a bare wildcard or start with one, an allow rule never covers a chained command (`git push*` will not approve `git push && rm -rf x`), and nothing can allow the refused list.

## Budgets and the evening summary

The hook reports how many tokens each Claude Code session has used. It reads only the token counts from Claude Code's own transcript, on your machine, and sends nothing else from it. Set a **daily token budget** per agent; when it is reached, further calls are refused until tomorrow (you are notified once). Cache reads count at one tenth, because they repeat every turn and cost far less. Optionally enter your model's price per million tokens to see dollars.

After 6 pm (your timezone), if your agents did anything, Orbit sends a short summary to your usual channels: calls made, what passed silently, what needed you, what was refused, usage, and which commands you were asked about most. That last one is how you tune your rules.

## What is stored

| Stored | Not stored |
| --- | --- |
| Tool name, a redacted and truncated summary of each call (the command, or the file path), project folder name, the decision and who made it, how long the agent waited, token counts per day | File contents, conversation text, query strings, anything that looks like a key or token (redacted before it is saved) |
| Rules and agents. Agent tokens and "always allow" commands are stored as hashes | The tokens themselves |

Events, answered requests and usage are deleted after `RUN_RETENTION_DAYS` (90 by default). Everything is included in the account export (without credentials) and removed with **Delete this account**.

## Security notes

- Each agent has its own token (192 random bits, shown once, stored as a hash), revocable, and rate limited. A wrong token and a revoked token are indistinguishable.
- Every failure path answers "no opinion", so a bug or outage can never silently approve something.
- Anything in a tool call is untrusted text. It is shown to you as plain text and can never approve itself: only your tap does.
- Waiting requests are capped per agent so a runaway loop can't flood your phone.
- Glob rules are matched in linear time (no regular expressions), so a pattern can't hang the server.

## Limits worth knowing

- Command analysis is a heuristic. It reads quotes, chains, substitutions and common disguises, but it is not a full shell interpreter.
- A script you let the agent run can do anything its code does. Orbit rates running an unknown script as not known to be safe.
- Only agents that offer a tool-call hook can be covered. Claude Code is supported today; other agents need a hook or proxy that calls the same endpoint (`POST /guard/v1/hook` with the same JSON).
- It was verified end to end with Claude Code 2.1.302 (see below), but not against other versions. If a Claude Code update changes the hook format, please open an issue.

## Verify it yourself

With an agent token and a settings file that registers the hook, Claude Code's non-interactive mode makes a cheap end-to-end test (it spends a few cents of tokens):

```bash
cd some-test-repo
claude -p 'Use the Bash tool to run exactly: git status --short. Reply DONE.' --settings guard-settings.json --model haiku --max-turns 4
# → passes silently; the Agents page logs it as a silent allow

claude -p 'Use the Bash tool to run exactly: rm -rf ./some-empty-dir. Say whether it ran.' --settings guard-settings.json --model haiku --max-turns 4
# → the call waits; deny it on the Agents page or your phone and Claude reports it was blocked by the hook
```

That is exactly how it was checked: a safe call allowed, a risky call held and denied, then the same call approved with *Always allow this here* and allowed silently on the next run. Token use from each session showed up on the agent.
