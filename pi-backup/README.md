# My pi Setup

A backup of my [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent configuration — extensions, agents, skills, policies, and the scripts that move it between machines.

pi is a terminal coding agent. Out of the box it is a single agent talking to you in one context window. This setup turns it into something closer to a small team: one orchestrator that plans and reviews, and short-lived subagents (scouts, workers, researchers) that do the legwork in their own isolated contexts and report back summaries. The orchestrator's context window stays small and clean; the raw work happens elsewhere and lands on disk where it can be traced later.

This repository is the whole setup, minus secrets and anything regenerable.

---

## The big picture

```
                         you
                          │  (normal pi session, or /orchestrator mode)
                          ▼
              ┌───────────────────────┐
              │    ORCHESTRATOR       │   plans · dispatches · reviews
              │  (your main session)  │   keeps only summaries in context
              └──────────┬────────────┘
        fire-and-forget  │  spawn: pi --mode rpc (headless, JSONL)
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   ┌─────────┐      ┌─────────┐      ┌──────────┐
   │  scout  │      │ worker  │      │researcher│   each in its own isolated
   │ (recon, │      │ (edits, │      │  (web)   │   context + own session file
   │ read-   │      │ tests,  │      │          │
   │  only)  │      │ builds) │      │          │
   └────┬────┘      └────┬────┘      └────┬─────┘
        │                │ can spawn its  │
        │                │ own scouts     │
        ▼                ▼                ▼
   full transcripts on disk (.jsonl) ── nothing is lost, nothing floods you
```

Three agent types exist:

- **scout** — read-only recon. Semantic search, LSP, AST queries, grep. Answers "where does X live / how does Y work" questions.
- **worker** — implements. Has edit tools, runs builds/tests, may ask you questions, may spawn its own scouts.
- **researcher** — external knowledge. Web search and fetch for library docs, API changes, "how do I do X in Y".

The orchestrator dispatches them fire-and-forget and ends its turn. When a subagent finishes, its final report is delivered back automatically as a steer message. The orchestrator never polls, never waits, and never sees the subagent's tool calls or thinking — only the distilled result.

---

## What's in this repo

```
pi-backup/
├── agent/                                    ← the backed-up ~/.pi/agent directory
│   ├── extensions/
│   │   ├── subagents/                        ← the orchestration extension (see below)
│   │   │   └── tests/                        ← deterministic selftest
│   │   └── pi-permission-system/
│   │       └── config.json                   ← the allow/ask/deny policy
│   ├── agents/                               ← scout.md, worker.md, researcher.md
│   ├── skills/                               ← ask-user decision-gate skill
|   ├── pi-blackhole/pi-blackhole-config.json ← pi-blackhole extension config
│   ├── orchestrator-workflow.md              ← appended by /orchestrator mode
│   ├── GIT_PACKAGES.txt                      ← git package manifest
│   └── npm/package.json                      ← npm package manifest
|   └── caveman.json, mcp.json ... etc.       ← other congfigs
└── scripts/
    ├── backup.sh                             ← refresh this repo's agent/ from ~/.pi/agent
    └── install.sh                            ← set up a new machine from this repo
```

`agent/` intentionally does **not** contain: `auth.json` (API keys — never leave your machine), `node_modules` (397 MB, rebuilt from the lockfile), `sessions/` (private transcripts), caches, or runtime logs.

---

## The subagents extension

The centerpiece, built for this setup. It lives in `agent/extensions/subagents/`.

**Spawning.** A subagent is a real, separate `pi --mode rpc` process — headless, driven over JSON-lines on stdin/stdout. No tmux, no pseudo-terminals, no terminal emulation. The parent writes the task as an RPC prompt and moves on immediately.

**Result delivery.** When the child exits, the extension extracts its final assistant message and injects it into the orchestrator as a steer message with a `subagent_result` marker. The orchestrator model wakes up with the answer already in its context.

**ask_user, unified.** If a subagent needs a decision, it doesn't guess. Its `ask_user` parks the child (a sidecar file), the question is routed to whoever can answer — the parent agent, escalating to the human — and the reply is written back via another sidecar. The child resumes exactly where it stopped. At the top level, `ask_user` renders a real interactive dialog. Same tool contract everywhere.

**Safety rails.** An execution-level interceptor rejects any tool call outside the child's allowlist before it runs, and never allows generic MCP gateways into children. Bash and filesystem policies come from the permission system (below), with `ask` decisions forwarded up to the root session so a headless child never silently fails an approval.

**The ribbon.** A live view above the editor: one box per running subagent (2 columns default), showing tool calls with their arguments, result summaries, and model thinking (dimmed). Alt+H/L move focus (the focused box is outlined), Alt+E zooms one pane full-width with the complete untruncated stream, Alt+J/K scroll a pane's history. Subagents spawned by workers — invisible to the orchestrator by design — are mirrored read-only from their on-disk activity files, so you can still see the whole tree working.

**Traceability.** Every subagent writes a full session transcript (every tool call, every result, every thought) to disk, plus a loadout snapshot of how it was spawned. `/subagent-tree` prints the whole spawn tree — names, session file paths, costs — so any run can be audited months later.

**Orchestrator mode.** `/orchestrator` toggles a workflow discipline (triage → plan → parallel discovery → implement → review → capped fix loop) into the system prompt, with a footer indicator. Off by default; normal sessions are unaffected.

**Testing.** `agent/extensions/subagents/tests/selftest.mjs` verifies the whole extension deterministically — compile against the installed pi's type definitions, unit tests for every renderer and buffer, a real extension-load probe, and a real RPC round-trip — all without a single LLM token. Run it after every pi update. `--live` adds one cheap real-model spawn check.

---

## How the pieces depend on each other

- **subagents ⇄ pi core**: spawns `pi --mode rpc` children; steers results back; uses pi's session files as the audit trail. Verified against each pi release by the selftest's compile + RPC probes.
- **subagents → pi-permission-system**: children inherit the permission policy. `ask` decisions are forwarded from the headless child to the root session's inbox, where the human approves. The extension checks the installed major version at startup and warns visibly if the contract surface may have drifted.
- **subagents → pi-blackhole**: children run with `PI_BLACKHOLE_PASSIVE=1`. Blackhole's observer/reflector/dropper machinery and its compaction override are tuned for long-running main sessions; a subagent does one task and exits, rarely touching a 1M-token window. Pi's native compaction remains active in children as a safety net. The orchestrator keeps full blackhole behavior.
- **orchestrator mode → subagents**: the workflow text assumes the dispatch/result machinery exists; it's shipped and versioned alongside the extension.
- **commandcode-provider**: the model/auth provider everything runs on. The agents' frontmatter pins models it serves.

---

## Why it's built this way

**Token economy.** The orchestrator's context is the scarcest resource in a long session. Every file it reads itself is context it pays for on every later turn. Delegation converts that into one compact summary per subagent, while the full transcripts live on disk at zero per-turn cost. A bug six hours later isn't a hallucinated memory — it's `/subagent-tree`, a session path, and the complete transcript.

**Clean context window.** Subagent contexts are isolated and short-lived. Their exploratory mess — failed greps, long file dumps, dead ends — never enters the orchestrator's window. Compaction pressure on the main session drops dramatically.

**Parallelism.** Independent scouts dispatch in the same turn and run concurrently. Discovery that would take twenty serial minutes takes one round trip.

**Discipline over vibes.** The workflow nudges the orchestrator to resolve ambiguity with the user before spending a dispatch, to write plans a worker can execute without guessing, and to cap fix loops (three worker runs, then surface to the human) instead of looping silently.

**Honest failure.** No API key, a 429-quota, a permission denial — each surfaces as an explicit, attributable error in the subagent's result rather than a hallucinated "done". The selftest gates pi updates mechanically: if the RPC surface changed upstream, the test says so before you've spent a token on a real session.

---

## Credits

- **Base architecture**: the subagent spawn/watch/lifecycle design is derived from [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) — that repo's source is the original this was built from, reworked to drop tmux/node-pty in favor of pi's native RPC mode and to integrate with the permission system.
- **ask_user**: the interactive UI is vendored from [pi-ask-user](https://github.com/edlsh/pi-ask-user) (MIT), with its decision-gate skill installed alongside. The tool contract is theirs; the headless sidecar parking/resume layer around it is custom.
- **pi** itself: [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

## Packages this setup uses

| Package | Role | Source |
|---|---|---|
| @earendil-works/pi-coding-agent | The agent runtime | [github](https://github.com/earendil-works/pi), [npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) |
| @gotgenes/pi-permission-system | Tool/bash/path allow-ask-deny policy, ask forwarding | [github](https://github.com/gotgenes/pi-packages) |
| pi-blackhole | Observational memory + compaction for main sessions | [github](https://github.com/k0valik/pi-blackhole) |
| pi-commandcode-provider | Model provider + auth (Command Code API) | [github](https://github.com/patlux/pi-commandcode-provider) |
| pi-ask-user | Original of the vendored ask_user UI | [github](https://github.com/edlsh/pi-ask-user) |
| pi-hashline-edit-pro | Hashline-anchored editing tools | [github](https://github.com/YuGiMob/pi-hashline-edit-pro) |
| pi-lsp-adapter | LSP tools (definitions, refs, diagnostics) | [github](https://github.com/nikmmd/pi-lsp-adapter) |
| pi-ast-grep | Structural code search | [npm](https://www.npmjs.com/package/pi-ast-grep) |
| pi-smart-web-search | Web search | [github](https://github.com/joematthews/pi-smart-web-search) |
| pi-smart-fetch | Browser-fingerprinted URL fetching | [github](https://github.com/Thinkscape/agent-smart-fetch) |
| pi-mcp-adapter | MCP server integration | [github](https://github.com/nicobailon/pi-mcp-adapter) |
| pi-caveman | Personality/terse-output layer | [github](https://github.com/jonjonrankin/pi-caveman) |
| pi-list-tools | Tool listing helper | [github](https://github.com/robobryce/pi-list-tools) |
| better-pi-rewind | Session rewind | [npm](https://www.npmjs.com/package/better-pi-rewind) |
| ponytail | Minimal-solution discipline (skill) | [github](https://github.com/DietrichGebert/ponytail) |

---

## Installing on a new machine

1. Install pi and Node.js (≥ 22).
2. Clone this repo anywhere: `git clone <this-repo> ~/pi-backup`
3. Run `bash ~/pi-backup/scripts/install.sh` — it copies configs, extensions, agents, and skills into `~/.pi/agent`, runs `npm install` against the stored lockfile, and reinstalls the git packages.
4. Add your API key: `pi /login` (or edit `~/.pi/agent/auth.json`). This file is deliberately not in the repo.
5. Start `pi` anywhere. Spawn a scout from any session to confirm.

## Backing up after changes

```bash
bash ~/pi-backup/scripts/backup.sh   # refresh agent/ from ~/.pi/agent
cd ~/pi-backup && git add -A && git commit -m "describe the change" && git push
```

## After a pi update

```bash
node ~/.pi/agent/extensions/subagents/tests/selftest.mjs --live
```

Zero-token checks run first (compile, load, RPC plumbing). If they pass, the extension is compatible; `--live` adds one real spawn as final proof. Only if something fails do you need to look closer — the failing step names the exact layer.
