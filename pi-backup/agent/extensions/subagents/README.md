# Subagents Extension

Orchestrator-side spawning + headless child role for pi, in one extension.
Project-local: `.pi/extensions/subagents/` (auto-discovered when the project is
trusted). Children run `pi --mode rpc` — no tmux, no pty, no terminal emulation.

## Files

| File | Role |
|------|------|
| `index.ts` | Entry. Registers `subagent`, `subagent_message`, `subagents_list`, unified `ask_user`, `/subagent-tree` command, message/entry renderers, and the N-box ribbon widget above the editor (one row set of side-by-side boxes, one per running subagent). Keys: Alt+H/L move focus (border highlights the focused pane; viewport follows), Alt+E zooms the focused pane full-width with tall wrapped full-fidelity content, Alt+J/K scroll the focused pane's history. Descendant boxes mirror worker-owned children read-only. Child role (env-gated): activity recorder, auto-exit, tool-allowlist interceptor. |
| `surface.ts` | RPC child process manager: spawn, steer/prompt, dual display buffers (short summaries for 2-up; full-fidelity args/results/thinking for zoom), auto-cancel stray dialogs, kill. Children spawn with `PI_BLACKHOLE_PASSIVE=1` so pi-blackhole's observer/reflector/dropper and compaction override stay off in subagents (pi's native compaction remains). |
| `session.ts` | Session JSONL parsing, last-assistant extraction, name registry, loadout snapshots, stats. |
| `activity.ts` | Subagent-side activity recorder + parent-side validator (phase protocol). |
| `status.ts` | Status classification (starting/active/waiting/stalled/recovered) + formatting. Optional config: `<project>/.pi/subagents.json` → `{"status":{"enabled":false},"ribbon":{"boxes":4,"lines":8}}`, or envs `PI_SUBAGENT_RIBBON_BOXES` / `PI_SUBAGENT_RIBBON_LINES`. |
| `ask-ui.ts` + `single-select-layout.ts` | Vendored from MIT-licensed `pi-ask-user` — interactive Branch A UI (`ctx.ui.custom`), with RPC dialog fallback. |
| Ask-user skill | Installed separately at `~/.pi/agent/skills/ask-user/` (from `pi-ask-user`'s skill). Teaches the decision-gate protocol for the `ask_user` tool — same tool contract, so the guidance applies as-is. |

## How it works

- **Spawn**: `pi -a --mode rpc --session <file> [--model m[:thinking]]
  [--append-system-prompt <body>] [--tools <allowlist>]` as a detached child.
  Task delivered as an RPC `prompt`. Fire-and-forget; result steers you back.
- **Tools**: no `--no-extensions`. Children discover all global extensions;
  `--tools` only filters exposure. An execution-level `tool_call` interceptor
  independently rejects anything outside the child's allowlist (and never
  allows `mcp`/`mcpScript`). `ask_user` + (when `subagent_agents` is set) the
  spawning tools are always added to the allowlist.
- **ask_user** (unified, branched on `PI_SUBAGENT_SESSION`):
  - Branch A (top-level, human-attended): vendored interactive UI.
  - Branch B (headless child): `.ask` sidecar → parent's watcher steers a
    `subagent_question` into the parent session → reply via
    `subagent_message({ name, message })` writes `.reply` → the blocked tool
    resolves with a parsed `AskResponse` (index/title match, comma-split for
    multi-select, else freeform). `timeout` (ms) resolves unanswered instead of
    parking forever (`.ask-timeout` marker tells the parent to stop holding it).
  - Nesting composes: scout's questions route to worker's model, which can
    escalate with its own `ask_user`.
- **Permission asks** (`@gotgenes/pi-permission-system`): children spawn with
  `PI_SUBAGENT_PARENT_SESSION` = root (human-attended) session id, so `ask`
  policies forward to the root session's inbox and the human answers there.
  Bash policy is owned entirely by that extension's `config.json` (global:
  `~/.pi/agent/extensions/pi-permission-system/config.json`) — there is no
  second pattern list in this extension.
  Installed as a pinned npm package, not vendored: our coupling is contract-level only (env var, inbox dirs, config schema). On session start the extension checks the installed major version against the validated range and shows a visible warning if it drifts — an upstream change surfaces as a notice, not silent breakage.
- **Lifecycle**: child auto-exits on a normally-completed turn (suppressed
  while an ask is parked or its own children run). `session_shutdown` kills
  every tracked child. Provider errors surface via a `.exit` sidecar.

## Env vars set on children

`PI_SUBAGENT_SESSION` (marks the child role), `PI_SUBAGENT_NAME`,
`PI_SUBAGENT_AGENT`, `PI_SUBAGENT_ID`, `PI_SUBAGENT_ACTIVITY_FILE`,
`PI_SUBAGENT_AUTO_EXIT`, `PI_SUBAGENT_ALLOWED` (spawnable agents),
`PI_SUBAGENT_TOOL_ALLOWLIST` (interceptor), `PI_SUBAGENT_PARENT_SESSION`
(permission-ask forwarding target), optional `PI_SUBAGENT_DEBUG=1` (writes
`/tmp/sa-probe/e2e/ext-debug.log` — repath before relying on it).

## Agent definitions

Scanned from `.pi/agents/`, `./agents/`, `~/.pi/agent/agents/` and
`../../agents` relative to this extension. Frontmatter: `name`, `description`,
`tools`, `model`, `thinking`, `system-prompt` (append/replace), `auto-exit`,
`interactive`, `subagent_agents`, `session-mode`, `cwd`,
`disable-model-invocation`.
