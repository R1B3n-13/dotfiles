// Unified subagent control extension (orchestrator + child roles in one file).
//
// Role is decided per process: `PI_SUBAGENT_SESSION` set = this process is a
// subagent (child). The same file is loaded everywhere:
//   - project-local discovery (`.pi/extensions/subagents/index.ts`) loads it in
//     every process whose cwd is this project, parent and children alike;
//   - `-e <this file>` is added explicitly only when a child runs in a
//     different cwd (where project discovery cannot find it).
//
// Orchestrator side: `subagent` / `subagent_message` / `subagents_list` tools,
// RPC surface (surface.ts), activity/status supervision, ask_user forwarding,
// N-box ribbon widget (Alt+H / Alt+L viewport).
//
// Child side: unified `ask_user` (Branch B async sidecar), execution-level
// tool allowlist interceptor, activity recorder, agent_end auto-exit.
//
// Children run `pi --mode rpc` — see surface.ts. No tmux/pty anywhere.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { runInteractiveAsk } from "./ask-ui.ts";
import {
	getSubagentActivityFile,
	readSubagentActivityFile,
	createSubagentActivityRecorder,
	type ActivityReadResult,
	type SubagentActivityState,
} from "./activity.ts";
import {
	countSessionEntryLines,
	findLastAssistantMessage,
	getNewEntries,
	getSessionId,
	readNameRegistry,
	readSubagentLoadout,
	registerName,
	resolveNameInRegistry,
	seedSubagentSessionFile,
	sessionSpawnTime,
	summarizeSessionStats,
	writeSubagentLoadout,
	type SessionStats,
} from "./session.ts";
import {
	loadExtensionConfig,
	advanceStatusState,
	capStatusLines,
	classifyStatus,
	createStatusState,
	forceStatusAfterInterrupt,
	formatStatusAggregate,
	formatTransitionLine,
	observeStatus,
	type SubagentStatusState,
} from "./status.ts";
import {
	killChild,
	rpcCommand,
	sendMessageToChild,
	spawnRpcChild,
	type RpcChild,
} from "./surface.ts";

const DEBUG_LOG = "/tmp/sa-probe/e2e/ext-debug.log";
function dbg(msg: string): void {
	if (!process.env.PI_SUBAGENT_DEBUG) return;
	try {
		appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
	} catch {}
}

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

// Survive /reload: stop timers/loops from a previous module load.
const TICK_INTERVAL_KEY = Symbol.for("pi-subagents/tick-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");
{
	const prevTick = (globalThis as any)[TICK_INTERVAL_KEY];
	if (prevTick) clearInterval(prevTick);
	(globalThis as any)[TICK_INTERVAL_KEY] = null;
	const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
	if (prevAbort) prevAbort.abort();
	(globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

const { status: statusConfig, ribbonBoxes: RIBBON_BOXES } = loadExtensionConfig();

/** Tools registered by this extension for spawning/nesting. */
const SPAWNING_TOOLS = ["subagent", "subagent_message", "subagents_list"] as const;
/** The unified ask tool — always granted to restricted subagents. */
const CONTROL_TOOLS = ["ask_user"] as const;
/** Generic MCP gateway tools: never exposed to a restricted subagent. */
const FORBIDDEN_TOOLS = new Set(["mcp", "mcpScript"]);

/** This process is a subagent (headless child) when its session env is set. */
const IS_SUBAGENT_PROCESS = !!process.env.PI_SUBAGENT_SESSION;

/** Per-agent spawn allowlist (PI_SUBAGENT_ALLOWED), or null for unrestricted. */
const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
	const raw = process.env.PI_SUBAGENT_ALLOWED;
	if (!raw) return null;
	const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
	return list.length > 0 ? new Set(list) : null;
})();

/** Execution-level allowlist for this child (mirrors its --tools filter). */
const CHILD_TOOL_ALLOWLIST: Set<string> | null = (() => {
	const raw = process.env.PI_SUBAGENT_TOOL_ALLOWLIST;
	if (!raw) return null;
	const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
	return list.length > 0 ? new Set(list) : null;
})();

function getAgentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// ── Agent definitions ────────────────────────────────────────────────────────

type AgentSource = "project" | "global" | "bundled";

interface AgentDefaults {
	model?: string;
	tools?: string;
	skills?: string;
	thinking?: string;
	subagentAgents?: string[];
	autoExit?: boolean;
	interactive?: boolean;
	systemPromptMode?: "append" | "replace";
	sessionMode?: "standalone" | "lineage-only" | "fork";
	cwd?: string;
	body?: string;
	disableModelInvocation?: boolean;
}

interface AgentDefinition extends AgentDefaults {
	name: string;
	description?: string;
	disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
	source: AgentSource;
}

function agentDiscoveryDirs(): Array<{ path: string; source: AgentSource }> {
	return [
		{ path: join(process.cwd(), ".pi", "agents"), source: "project" },
		{ path: join(process.cwd(), "agents"), source: "project" },
		{ path: join(getAgentConfigDir(), "agents"), source: "global" },
		{ path: resolve(SUBAGENTS_DIR, "..", "..", "..", "agents"), source: "bundled" },
	];
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
	const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
	return value != null ? value === "true" : undefined;
}

function parseCommaList(value: string | undefined): string[] | undefined {
	if (value == null) return undefined;
	const list = value.split(",").map((s) => s.trim()).filter(Boolean);
	return list.length > 0 ? list : undefined;
}

export function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;

	const frontmatter = match[1];
	const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

	return {
		name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
		description: getFrontmatterValue(frontmatter, "description"),
		model: getFrontmatterValue(frontmatter, "model"),
		tools: getFrontmatterValue(frontmatter, "tools"),
		systemPromptMode:
			systemPromptMode === "replace" ? "replace" : systemPromptMode === "append" ? "append" : undefined,
		skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
		thinking: getFrontmatterValue(frontmatter, "thinking"),
		subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
		autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
		interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
		sessionMode:
			getFrontmatterValue(frontmatter, "session-mode") === "fork"
				? "fork"
				: getFrontmatterValue(frontmatter, "session-mode") === "lineage-only"
					? "lineage-only"
					: undefined,
		cwd: getFrontmatterValue(frontmatter, "cwd"),
		body: body || undefined,
		disableModelInvocation:
			getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
	};
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
	const agents = new Map<string, ListedAgentDefinition>();
	for (const { path: dir, source } of agentDiscoveryDirs()) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
			const parsed = parseAgentDefinition(readFileSync(join(dir, file), "utf8"), file.replace(/\.md$/, ""));
			if (!parsed) continue;
			agents.set(parsed.name, { ...parsed, source });
		}
	}
	const all = [...agents.values()];
	return SUBAGENT_ALLOWLIST ? all.filter((a) => SUBAGENT_ALLOWLIST.has(a.name)) : all;
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
	for (const { path: dir } of agentDiscoveryDirs()) {
		const p = join(dir, `${agentName}.md`);
		if (!existsSync(p)) continue;
		const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
		if (parsed) return parsed;
	}
	return null;
}

function resolveEffectiveInteractive(agentDefs: AgentDefaults | null): boolean {
	if (agentDefs?.interactive != null) return agentDefs.interactive;
	return !(agentDefs?.autoExit ?? false);
}

// ── Paths ────────────────────────────────────────────────────────────────────

function getArtifactDir(sessionDir: string, sessionId: string): string {
	return join(sessionDir, "artifacts", sessionId);
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "sessions", safePath);
	if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

// ── Tool allowlist ───────────────────────────────────────────────────────────

/**
 * Build the child `--tools` allowlist: requested tools (frontmatter) + the
 * control tools + spawning tools when granted. `mcp`/`mcpScript` are never
 * granted — they are generic gateways that would defeat every other
 * restriction. Returns null when there is no restriction at all.
 */
export function buildSubagentToolAllowlist(
	effectiveTools: string | undefined,
	opts?: { grantSpawning?: boolean },
): string | null {
	const requested = (effectiveTools ?? "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);

	const grantSpawning = opts?.grantSpawning ?? false;
	if (requested.length === 0 && !grantSpawning) return null;

	const allow = new Set(requested);
	if (grantSpawning) for (const tool of SPAWNING_TOOLS) allow.add(tool);
	for (const tool of CONTROL_TOOLS) allow.add(tool);
	for (const tool of FORBIDDEN_TOOLS) allow.delete(tool);

	return [...allow].join(",");
}

// ── Running subagent state ───────────────────────────────────────────────────

interface PendingAskPayload {
	name: string;
	agent: string;
	question: string;
	context?: string;
	options?: Array<{ title: string; description?: string }>;
	allowMultiple?: boolean;
	allowFreeform?: boolean;
	allowComment?: boolean;
	timeout?: number;
	askedAt: number;
}

interface RunningSubagent {
	id: string;
	name: string;
	task: string;
	agent?: string;
	child: RpcChild;
	startTime: number;
	sessionFile: string;
	/** Session entries before launch/resume — summary extraction boundary. */
	entryCountBefore: number;
	activityFile?: string;
	activity?: SubagentActivityState;
	activityRead?: { ok: boolean; reason?: string; error?: string };
	statusState: SubagentStatusState;
	interactive: boolean;
	pendingAsk?: PendingAskPayload;
}

const runningSubagents = new Map<string, RunningSubagent>();
const reservedNames = new Set<string>();

// Worker needs to know if it still has children in flight (auto-exit gate).
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runningSubagents.size;

let latestCtx: ExtensionContext | null = null;
let latestPi: ExtensionAPI | null = null;
/** Child role: set while a Branch-B ask_user is parked awaiting a reply. */
let awaitingAnswer = false;
let ribbonOffset = 0;

// ── Name helpers ─────────────────────────────────────────────────────────────

function uniqueRunningName(base: string, registryNames?: Set<string>): string {
	const taken = new Set(Array.from(runningSubagents.values()).map((r) => r.name));
	for (const reserved of reservedNames) taken.add(reserved);
	if (registryNames) for (const n of registryNames) taken.add(n);
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}


// ── Status supervision ───────────────────────────────────────────────────────

function activityLabel(activity: SubagentActivityState): string | undefined {
	if (activity.phase !== "active") return undefined;
	if (activity.activeScope === "tool") return activity.toolName ?? "tool";
	if (activity.activeScope === "provider") return "provider";
	if (activity.activeScope === "streaming") return "streaming";
	return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()): void {
	const read: ActivityReadResult = running.activityFile
		? readSubagentActivityFile(running.activityFile, running.id)
		: { ok: false, reason: "missing" };

	running.activityRead = read.ok
		? { ok: true }
		: { ok: false, reason: read.reason, error: read.error };

	if (read.ok) {
		running.activity = read.activity;
		running.statusState = observeStatus(
			running.statusState,
			{
				snapshot: "present",
				updatedAt: read.activity.updatedAt,
				sequence: read.activity.sequence,
				phase: read.activity.phase,
				active: read.activity.phase === "active",
				activeScope: read.activity.activeScope,
				activeSince: read.activity.activeSince,
				waitingSince: read.activity.waitingSince,
				latestEvent: read.activity.latestEvent,
				activityLabel: activityLabel(read.activity),
			},
			observedAt,
		);
		return;
	}

	running.statusState = observeStatus(
		running.statusState,
		{ snapshot: read.reason as any, snapshotError: read.error },
		observedAt,
	);
}

// ── ask_user sidecar plumbing ────────────────────────────────────────────────

function formatAskQuestionText(running: RunningSubagent, payload: PendingAskPayload, elapsedSec: number): string {
	const lines = [`Sub-agent "${running.name}" asks (${elapsedSec}s):`, "", payload.question];
	if (payload.context) lines.push("", `Context: ${payload.context}`);
	if (payload.options && payload.options.length > 0) {
		lines.push("", "Options:");
		payload.options.forEach((opt, i) => {
			lines.push(`${i + 1}. ${opt.title}${opt.description ? ` — ${opt.description}` : ""}`);
		});
		if (payload.allowMultiple) lines.push("(you may pick several, comma-separated)");
		if (payload.allowFreeform !== false) lines.push("(or reply in your own words)");
	}
	lines.push(
		"",
		`Reply with subagent_message({ name: "${running.name}", message: "…" }) — the same name works whether it is still running or has since exited.`,
	);
	return lines.join("\n");
}

function deliverPendingQuestion(running: RunningSubagent): void {
	const askFile = `${running.sessionFile}.ask`;
	let payload: any = null;
	try {
		if (!existsSync(askFile)) return;
		payload = JSON.parse(readFileSync(askFile, "utf-8"));
	} catch {
		return; // malformed/partway-written — try again next tick
	}
	try {
		unlinkSync(askFile);
	} catch {}
	if (!payload?.question) return;

	const full: PendingAskPayload = { ...payload, askedAt: Date.now() };
	running.pendingAsk = full;

	const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
	const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;

	latestPi?.sendMessage(
		{
			customType: "subagent_question",
			content: formatAskQuestionText(running, full, elapsed),
			display: true,
			details: {
				name: running.name,
				agent: running.agent,
				question: full.question,
				options: full.options ?? [],
				...(sessionId ? { sessionId } : {}),
			},
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

/** Parse a plain-text reply into an AskResponse (spec: Branch B reply parsing). */
export function parseAskReply(
	text: string,
	payload: Pick<PendingAskPayload, "options" | "allowMultiple">,
): { kind: "selection"; selections: string[] } | { kind: "freeform"; text: string } {
	const t = text.trim();
	const titles = (payload.options ?? []).map((o) => o.title);

	const matchToken = (token: string): string | null => {
		const num = token.match(/^\d+$/);
		if (num) {
			const idx = Number.parseInt(token, 10) - 1;
			return titles[idx] ?? null;
		}
		const exact = titles.find((title) => title.toLowerCase() === token.toLowerCase());
		return exact ?? null;
	};

	if (payload.allowMultiple && titles.length > 0) {
		const parts = t.split(",").map((s) => s.trim()).filter(Boolean);
		const selections: string[] = [];
		for (const part of parts) {
			selections.push(matchToken(part) ?? part);
		}
		if (selections.length > 0) return { kind: "selection", selections };
		return { kind: "freeform", text: t };
	}

	if (titles.length > 0) {
		const matched = matchToken(t);
		if (matched) return { kind: "selection", selections: [matched] };
	}
	return { kind: "freeform", text: t };
}

// ── Launch ───────────────────────────────────────────────────────────────────

export interface SubagentResult {
	name: string;
	task: string;
	summary: string;
	sessionFile?: string;
	sessionId?: string;
	exitCode: number;
	elapsed: number;
	error?: string;
	errorMessage?: string;
	stats?: SessionStats;
}

/**
 * Session id this process's children should forward permission asks to.
 * Top-level: own session id. Subagent: the parent session id we were given —
 * children pass it down so asks reach the root (human-attended) session.
 */
function rootParentSessionId(ctx: { sessionManager: { getSessionId(): string } }): string {
	return process.env.PI_SUBAGENT_PARENT_SESSION ?? ctx.sessionManager.getSessionId();
}

async function launchSubagent(
	params: { agent?: string; name?: string; task: string; model?: string; cwd?: string },
	ctx: {
		sessionManager: { getSessionFile(): string | null | undefined; getSessionId(): string; getSessionDir(): string };
		cwd: string;
	},
): Promise<RunningSubagent> {
	const startTime = Date.now();
	const id = Math.random().toString(16).slice(2, 10);

	const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
	const effectiveModel = params.model ?? agentDefs?.model;
	const effectiveThinking = agentDefs?.thinking;
	const effectiveInteractive = resolveEffectiveInteractive(agentDefs);

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("No session file");
	const sessionId = ctx.sessionManager.getSessionId();
	const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

	const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
	const effectiveCwd = rawCwd ? (rawCwd.startsWith("/") ? rawCwd : join(ctx.cwd, rawCwd)) : null;
	const targetCwdForSession = effectiveCwd ?? ctx.cwd;
	const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
	const effectiveAgentDir =
		localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
	const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

	// Deterministic session file path (parallel-spawn safe).
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
	const uuid = [
		id,
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 6),
	].join("-");
	const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

	if (agentDefs?.sessionMode === "fork" || agentDefs?.sessionMode === "lineage-only") {
		seedSubagentSessionFile({
			mode: agentDefs.sessionMode,
			parentSessionFile: sessionFile,
			childSessionFile: subagentSessionFile,
			childCwd: targetCwdForSession,
		});
	}

	const activityFile = getSubagentActivityFile(artifactDir, id);
	mkdirSync(dirname(activityFile), { recursive: true });

	const grantSpawning = !!(agentDefs?.subagentAgents && agentDefs.subagentAgents.length > 0);
	const identity = agentDefs?.body ?? null;
	const systemPromptMode = agentDefs?.systemPromptMode;
	const identityInSystemPrompt = !!(systemPromptMode && identity);
	const toolAllowlist = buildSubagentToolAllowlist(agentDefs?.tools, { grantSpawning });

	const modeHint = agentDefs?.autoExit
		? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
		: "Complete your task. The user can interact with you at any time, and the session ends when the user exits.";
	const summaryInstruction = agentDefs?.autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
	const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
	const fullTask = `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`.trim();

	// Build the pi RPC child command. Global extension discovery stays ON — the
	// child discovers every globally installed extension exactly like this
	// process. `--tools` only filters exposure.
	// -a: project trust is inherited from this (trusted) process — without it
	// the child would silently skip project-local extensions in RPC mode.
	const args: string[] = ["-a", "--mode", "rpc", "--session", subagentSessionFile];
	if (effectiveModel) {
		const suffix = effectiveThinking && !effectiveModel.includes(":") ? `:${effectiveThinking}` : "";
		args.push("--model", `${effectiveModel}${suffix}`);
	}
	if (identityInSystemPrompt && identity) {
		args.push(systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", identity);
	}
	if (toolAllowlist) args.push("--tools", toolAllowlist);
	// Explicit load only when the child's cwd cannot discover this project-local
	// extension (avoids double registration when it can).
	if (resolve(effectiveCwd ?? ctx.cwd) !== resolve(process.cwd())) {
		args.push("-e", THIS_FILE);
	}

	const env: NodeJS.ProcessEnv = {};
	if (localAgentDir && existsSync(localAgentDir)) env.PI_CODING_AGENT_DIR = localAgentDir;
	else if (process.env.PI_CODING_AGENT_DIR) env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	if (grantSpawning && agentDefs?.subagentAgents) {
		env.PI_SUBAGENT_ALLOWED = agentDefs.subagentAgents.join(",");
	}
	env.PI_SUBAGENT_NAME = params.name ?? "subagent";
	if (params.agent) env.PI_SUBAGENT_AGENT = params.agent;
	if (agentDefs?.autoExit) env.PI_SUBAGENT_AUTO_EXIT = "1";
	env.PI_SUBAGENT_SESSION = subagentSessionFile;
	env.PI_SUBAGENT_ID = id;
	env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
	if (toolAllowlist) env.PI_SUBAGENT_TOOL_ALLOWLIST = toolAllowlist;
	// Permission-ask forwarding: name the root (human-attended) session.
	env.PI_SUBAGENT_PARENT_SESSION = rootParentSessionId(ctx);
	// Subagents are short-lived; skip blackhole's observer/reflector/dropper and
	// its compaction override. Pi's native compaction stays active as the safety net.
	env.PI_BLACKHOLE_PASSIVE = "1";

	writeSubagentLoadout(subagentSessionFile, {
		agent: params.agent ?? null,
		toolAllowlist,
		model: effectiveModel ?? null,
		thinking: effectiveThinking ?? null,
		systemPromptMode: systemPromptMode ?? null,
		identity: identityInSystemPrompt ? identity : null,
		spawnable: agentDefs?.subagentAgents ?? null,
		autoExit: agentDefs?.autoExit ?? false,
		cwd: effectiveCwd ?? null,
		agentDir: effectiveAgentDir,
		parentSessionId: env.PI_SUBAGENT_PARENT_SESSION,
	});
	dbg(`launch start: ${params.name} args=${JSON.stringify(args)}`);
	const child = spawnRpcChild({
		onExit: () => {
			const r = runningSubagents.get(id);
			if (r) finishRunningSubagent(r);
		},
		id,
		args,
		env,
		cwd: effectiveCwd ?? ctx.cwd,
		sessionFile: subagentSessionFile,
	});

	const running: RunningSubagent = {
		id,
		name: params.name ?? "subagent",
		task: params.task,
		agent: params.agent,
		child,
		startTime,
		sessionFile: subagentSessionFile,
		entryCountBefore: 0,
		activityFile,
		interactive: effectiveInteractive,
		statusState: createStatusState({ startTimeMs: startTime }),
	};

	runningSubagents.set(id, running);

	// Initial task + skill prompts. Extension commands (none expected) would
	// need direct delivery; skill prompts expand inside the child like CLI args.
	dbg("child spawned, sending prompt");
	try {
		const skills = (agentDefs?.skills ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		for (const skill of skills) {
			await rpcCommand(child, { type: "prompt", message: `/skill:${skill}` });
		}
		const promptRes = await rpcCommand(child, { type: "prompt", message: fullTask });
		if (promptRes.success === false) {
			child.lastError = String(promptRes.error ?? "initial prompt rejected");
			killChild(child);
		}
	} catch (err) {
		child.lastError = err instanceof Error ? err.message : String(err);
		killChild(child);
	}

	dbg(`launch done: ${params.name}`);
	return running;
}

// ── Result extraction + watcher ──────────────────────────────────────────────

function extractSummary(running: RunningSubagent): { summary: string; exitCode: number; errorMessage?: string } {
	const exitCode = running.child.exitCode ?? 1;

	// .exit sidecar (written by the child on stopReason=error) carries the
	// provider error message; prefer it over a stale assistant message.
	let errorMessage: string | undefined;
	const exitFile = `${running.sessionFile}.exit`;
	try {
		if (existsSync(exitFile)) {
			const parsed = JSON.parse(readFileSync(exitFile, "utf8"));
			if (parsed?.type === "error" && typeof parsed.errorMessage === "string") {
				errorMessage = parsed.errorMessage;
			}
			try {
				unlinkSync(exitFile);
			} catch {}
		}
	} catch {}

	let summary: string;
	if (errorMessage) {
		summary = `Subagent error: ${errorMessage}`;
	} else if (existsSync(running.sessionFile)) {
		const entries = getNewEntries(running.sessionFile, running.entryCountBefore);
		summary =
			findLastAssistantMessage(entries) ??
			(exitCode !== 0 ? `Sub-agent exited with code ${exitCode}` : "Sub-agent exited without output");
	} else {
		summary =
			exitCode !== 0
				? `Sub-agent exited with code ${exitCode}`
				: "Sub-agent exited without output";
	}
	if (running.child.lastError && !errorMessage) {
		summary = `${summary}\n\n(stderr: ${running.child.lastError})`;
	}

	return { summary, exitCode, errorMessage };
}

function resolveResultPresentation(result: SubagentResult, name: string): string {
	const sessionRef = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;
	const elapsed = formatElapsedShort(result.elapsed);

	if (result.errorMessage) {
		return (
			`Sub-agent "${name}" failed after ${elapsed} (provider/agent error — auto-retry exhausted).\n\n` +
			`Error: ${result.errorMessage}\n\n` +
			`The subagent did not produce a result. You can retry by spawning a new subagent or resume the session with subagent_message.${sessionRef}`
		);
	}

	return result.exitCode !== 0
		? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
		: `Sub-agent "${name}" completed (${elapsed}).\n\n${result.summary}${sessionRef}`;
}

function formatElapsedShort(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m ${s}s`;
}

function finishRunningSubagent(running: RunningSubagent): void {
	// Small delay: the child flushes its session file right before exit.
	setTimeout(() => {
		const pi = latestPi;
		if (!pi) return;
		const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
		const { summary, exitCode, errorMessage } = extractSummary(running);
		const stats = existsSync(running.sessionFile) ? summarizeSessionStats(running.sessionFile) : null;
		const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;

		runningSubagents.delete(running.id);
		updateWidget();

		const result: SubagentResult = {
			name: running.name,
			task: running.task,
			summary,
			sessionFile: running.sessionFile,
			...(sessionId ? { sessionId } : {}),
			exitCode,
			elapsed,
			...(errorMessage ? { errorMessage } : {}),
			...(stats ? { stats } : {}),
		};

		pi.sendMessage(
			{
				customType: "subagent_result",
				content: resolveResultPresentation(result, running.name),
				display: true,
				details: {
					name: running.name,
					task: running.task,
					agent: running.agent,
					exitCode,
					elapsed,
					sessionFile: running.sessionFile,
					...(sessionId ? { sessionId } : {}),
					...(errorMessage ? { errorMessage } : {}),
					...(stats ? { stats } : {}),
				},
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}, 300);
}

// ── Widget (N-box ribbon) ────────────────────────────────────────────────────

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";
const RIBBON_CONTENT_LINES = loadExtensionConfig().ribbonLines;
/** Zoom mode: focused pane takes the full width with extra rows. */
let ribbonZoom = false;
/** Focused pane index (into the full entry list). */
let ribbonFocus = 0;
/** Lines scrolled back from the tail inside the focused pane. */
let paneScroll = 0;

const DIM = "\x1b[90m";

function borderTop(title: string, info: string, width: number, focused: boolean): string {
	if (width <= 2) return "";
	const inner = Math.max(0, width - 2);
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
	const fill = "─".repeat(fillLen);
	const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
	const color = focused ? ACCENT : DIM;
	return `${color}╭${content}╮${RST}`;
}

function borderBottom(width: number, focused: boolean): string {
	if (width <= 2) return "";
	const inner = Math.max(0, width - 2);
	const color = focused ? ACCENT : DIM;
	return `${color}╰${"─".repeat(inner)}╯${RST}`;
}

function boxLine(left: string, width: number, color: string = ACCENT): string {
	if (width <= 2) return "";
	const contentWidth = Math.max(0, width - 2);
	const truncLeft = truncateToWidth(left, contentWidth);
	const pad = Math.max(0, contentWidth - visibleWidth(truncLeft));
	return `${color}│${RST}${truncLeft}${" ".repeat(pad)}${color}│${RST}`;
}

function formatWidgetRightLabel(snapshot: ReturnType<typeof classifyStatus>): string {
	if (snapshot.kind === "starting") return " starting… ";
	if (snapshot.kind === "active") {
		const label = snapshot.activityLabel ?? snapshot.activeScope;
		const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
		return label ? ` ${label}${duration} ` : " active ";
	}
	if (snapshot.kind === "waiting") {
		const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
		const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
		return ` waiting${duration}${detail} `;
	}
	if (snapshot.kind === "stalled") {
		const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
		return ` stalled${detail} `;
	}
	return ` running ${snapshot.elapsedText} `;
}

/** One renderable box in the ribbon row. Direct children carry live output
 * buffers; mirrored descendants carry their on-disk activity summary. */
interface RibbonEntry {
	name: string;
	agent?: string;
	startTime: number;
	statusText: string;
	/** Short lines (summaries) shown in the 2-up view. */
	lines: string[];
	/** Full-fidelity lines (untruncated args/results/thinking) shown zoomed. */
	fullLines?: string[];
}

export interface RibbonRenderOptions {
	/** Content rows per (unzoomed) box. Default: configured ribbonLines. */
	contentLines?: number;
	/** Zoom: show only the focused pane, full width, extra rows. */
	zoom?: boolean;
	/** Focused pane index (into `entries`). */
	focus?: number;
	/** Lines scrolled back from the tail in the focused pane. */	scroll?: number;
	/** Theme for dim styling of thinking lines (`┆ ` prefix). */
	theme?: unknown;
}

/** Word-wrap a line into display segments of ~`cols` visible characters. */
function wrapLine(text: string, cols: number): string[] {
	if (text.length === 0) return [""];
	const out: string[] = [];
	let rest = text;
	while (rest.length > cols) {
		let cut = rest.lastIndexOf(" ", cols);
		if (cut < Math.floor(cols * 0.5)) cut = cols;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^ +/, "");
	}
	out.push(rest);
	return out;
}

/** Estimated content rows for zoom mode (~half the terminal, clamped). */
function zoomRowCount(baseRows: number): number {
	const h = process.stdout?.rows ?? 0;
	if (!Number.isFinite(h) || h <= 0) return baseRows * 3;
	return Math.max(baseRows, Math.min(40, Math.floor(h / 2) - 4));
}

/** N side-by-side boxes above the editor, joined into one row set. */
export function renderRibbonLines(entries: RibbonEntry[], width: number, opts: RibbonRenderOptions = {}): string[] {
	const total = entries.length;
	if (total === 0) return [];
	const zoom = opts.zoom === true;
	const scroll = Math.max(0, Math.floor(opts.scroll ?? 0));
	const baseRows = Math.max(1, opts.contentLines ?? RIBBON_CONTENT_LINES);
	const n = zoom ? 1 : Math.min(RIBBON_BOXES, total);

	// Focus drives the viewport: the window slides to keep the focused pane visible.
	const focus = Math.max(0, Math.min(Math.floor(opts.focus ?? 0), total - 1));
	let offset = Math.min(ribbonOffset, Math.max(0, total - n));
	if (focus < offset) offset = focus;
	if (focus >= offset + n) offset = focus - n + 1;
	ribbonOffset = Math.max(0, Math.min(offset, Math.max(0, total - n)));
	const visible = entries.slice(ribbonOffset, ribbonOffset + n);

	const boxWidth = Math.max(12, Math.floor((width - (n - 1)) / n) - 1);
	const rows = zoom ? zoomRowCount(baseRows) : baseRows;
	const lines: string[] = [];

	const dim = typeof (opts.theme as any | undefined)?.fg === "function" ? (opts.theme as any) : null;
	const styleLine = (text: string) => (text.startsWith("┆ ") && dim ? dim.fg("dim", text) : text);
	const tops = visible.map((entry, i) => {
		const elapsed = formatElapsedShort(Math.floor((Date.now() - entry.startTime) / 1000));
		const isFocus = ribbonOffset + i === focus;
		const zoomTag = zoom ? " (zoom — Alt+E to restore)" : "";
		return borderTop(
			`${entry.name}${entry.agent ? ` (${entry.agent})` : ""}${zoomTag}`,
			`${entry.statusText} ${elapsed}`,
			boxWidth,
			isFocus,
		);
	});
	lines.push(tops.join(" "));

	// Content rows: tail of each box's buffer, side by side. Zoom renders the
	// full-fidelity buffer word-wrapped; the 2-up view shows short summaries.
	const cellsFor = (entry: RibbonEntry, row: number, paneColor: string): string => {
		const source = zoom ? entry.fullLines ?? entry.lines : entry.lines;
		if (zoom) {
			// Walk the full buffer from the tail, wrapping lines, until `rows`
			// display rows (offset by the scroll) are covered.
			const maxScroll = Math.max(0, source.length - 1);
			const back = Math.min(scroll, maxScroll);
			let needed = rows;
			const display: string[] = [];
			for (let i = source.length - 1 - back; i >= 0 && display.length < needed; i--) {
				const segs = wrapLine(source[i] ?? "", Math.max(10, boxWidth - 4));
				for (let s = segs.length - 1; s >= 0 && display.length < needed; s--) {
					display.unshift(s === 0 ? segs[s] : `  ${segs[s]}`);
				}
			}
			let text = display[Math.min(row, display.length - 1)] ?? "";
			if (row === 0 && text === "") text = entry.statusText;
			return boxLine(` ${styleLine(text)}`, boxWidth, paneColor);
		}
		const maxScroll = Math.max(0, entry.lines.length - rows);
		const back = Math.min(scroll, maxScroll);
		const from = Math.max(0, entry.lines.length - rows - back);
		const window = entry.lines.slice(from, from + rows);
		let text = window[row] ?? "";
		if (row === 0 && text === "") text = entry.statusText;
		return boxLine(` ${styleLine(text)}`, boxWidth, paneColor);
	};
	for (let row = 0; row < rows; row++) {
		lines.push(
			visible
				.map((entry, i) => cellsFor(entry, row, ribbonOffset + i === focus ? ACCENT : DIM))
				.join(" "),
		);
	}

	const bottoms = visible.map((_, i) => borderBottom(boxWidth, ribbonOffset + i === focus));
	lines.push(bottoms.join(" "));

	const hints: string[] = [];
	const focusedName = entries[focus]?.name ?? "";
	hints.push(`focus: ${focusedName} — Alt+H/L move`);
	if (total > n) hints.push(`${ribbonOffset + 1}-${ribbonOffset + n} of ${total}`);
	if (zoom) hints.push("Alt+E restore");
	else hints.push("Alt+E zoom");
	if (scroll > 0) hints.push("Alt+J to bottom");
	if (hints.length > 0) lines.push(` ${hints.join(" · ")}`);
	return lines;
}

const DESCENDANT_FRESH_MS = 20_000;

function readJsonFile(path: string): any | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Read-only mirror of a spawner's descendants. `artifactDir` is the spawner's
 * OWN artifact dir (<sessionDir>/artifacts/<spawnerSessionId>) — its registry
 * maps the children it spawned and its subagent-activity/ holds their live
 * activity files. Only fresh, non-done activity is surfaced. Control stays
 * with the owner — this only reads files the children already publish.
 */
export function collectDescendantEntries(artifactDir: string, depth = 0): RibbonEntry[] {
	if (depth >= 2) return [];
	const registry = readNameRegistry(artifactDir);
	const activityDir = join(artifactDir, "subagent-activity");
	let ids: string[] = [];
	try {
		ids = readdirSync(activityDir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const now = Date.now();
	const out: RibbonEntry[] = [];
	for (const file of ids) {
		const childId = file.replace(/\.json$/, "");
		const activity = readJsonFile(join(activityDir, file));
		if (!activity || activity.phase === "done") continue;
		if (now - (activity.updatedAt ?? 0) > DESCENDANT_FRESH_MS) continue;
		// Resolve the child's display name via its session file (uuid embeds id).
		let name: string | null = null;
		let childSessionFile: string | undefined;
		for (const [regName, entry] of Object.entries(registry)) {
			if (entry.sessionFile.includes(`_${childId}-`)) {
				name = regName;
				childSessionFile = entry.sessionFile;
				break;
			}
		}
		if (!name) name = childId;
		const tool = activity.toolName ? `: ${activity.toolName}` : "";
		out.push({
			name,
			agent: activity.agent ?? undefined,
			startTime: activity.createdAt ?? now,
			statusText: `${activity.phase}${tool}`,
			lines: [
				`event: ${activity.latestEvent ?? "?"}`,
				`scope: ${activity.activeScope ?? "-"} · updated ${formatElapsedShort(Math.max(0, Math.floor((now - (activity.updatedAt ?? now)) / 1000)))} ago`,
			],
		});
		// Recurse into this child's own artifact dir for ITS descendants.
		if (childSessionFile && existsSync(childSessionFile) && depth + 1 < 2) {
			const sid = getSessionId(childSessionFile);
			if (sid) {
				out.push(
					...collectDescendantEntries(join(dirname(childSessionFile), "artifacts", sid), depth + 1),
				);
			}
		}
	}
	// readdir order is arbitrary; show siblings in spawn order.
	out.sort((a, b) => a.startTime - b.startTime);
	return out;
}

function buildRibbonEntries(): RibbonEntry[] {
	const direct = Array.from(runningSubagents.values()).sort((a, b) => a.startTime - b.startTime);
	const entries: RibbonEntry[] = direct.map((running) => {
		const snapshot = classifyStatus(running.statusState, Date.now());
		return {
			name: running.name,
			agent: running.agent,
			startTime: running.startTime,
			statusText: formatWidgetRightLabel(snapshot).trim(),
			lines: running.child.lines,
			fullLines: running.child.fullLines,
		};
	});
	for (const parent of direct) {
		// Each child's OWN artifact dir — never the orchestrator's artifacts dir,
		// which would mirror every running child under every parent (count inflation).
		const sid = getSessionId(parent.sessionFile);
		if (!sid) continue;
		entries.push(...collectDescendantEntries(join(dirname(parent.sessionFile), "artifacts", sid)));
	}
	return entries;
}

function updateWidget(): void {
	if (!latestCtx?.hasUI) return;
	if (IS_SUBAGENT_PROCESS) return; // children don't render a ribbon

	if (runningSubagents.size === 0) {
		latestCtx.ui.setWidget("subagent-ribbon", undefined);
		stopTick();
		return;
	}

	latestCtx.ui.setWidget(
		"subagent-ribbon",
		(tui: any, theme: any) => ({
			invalidate() {},
			render(width: number) {
				return renderRibbonLines(buildRibbonEntries(), width, {
					zoom: ribbonZoom,
					focus: ribbonFocus,
					scroll: paneScroll,
					theme,
				});
			},
		}),
		{ placement: "aboveEditor" },
	);
	return;
}

// ── Supervision tick (activity, asks, transitions, widget) ───────────────────

let tickInterval: ReturnType<typeof setInterval> | null = null;

function startTick(pi: ExtensionAPI): void {
	if (tickInterval) return;
	tickInterval = setInterval(() => {
		if (runningSubagents.size === 0) {
			stopTick();
			return;
		}
		const now = Date.now();
		const transitionLines: string[] =[];

		for (const running of runningSubagents.values()) {
			observeRunningSubagent(running, now);
			const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
			running.statusState = nextState;

			if (transition && !running.interactive) {
				transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
			}

			deliverPendingQuestion(running);

			// Child timed out on its ask: it wrote an .ask-timeout marker. Clear our
			// side so later subagent_message replies go out as steers instead.
			const timeoutMarker = `${running.sessionFile}.ask-timeout`;
			if (running.pendingAsk && existsSync(timeoutMarker)) {
				running.pendingAsk = undefined;
				try {
					unlinkSync(timeoutMarker);
				} catch {}
			}
		}

		updateWidget();

		if (transitionLines.length > 0 && statusConfig.enabled) {
			const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
			pi.sendMessage(
				{
					customType: "subagent_status",
					content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
					display: true,
					details: { lines: capped.visibleLines, overflow: capped.overflow },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		}
	}, 1000);
	(globalThis as any)[TICK_INTERVAL_KEY] = tickInterval;
}

function stopTick(): void {
	if (tickInterval) {
		clearInterval(tickInterval);
		tickInterval = null;
		(globalThis as any)[TICK_INTERVAL_KEY] = null;
	}
}

// ── Child role: activity recorder + auto-exit + interceptor ──────────────────

function createChildRoleHandlers(pi: ExtensionAPI): void {
	const recorder = createSubagentActivityRecorder({
		runningChildId: process.env.PI_SUBAGENT_ID,
		activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
	});

	pi.on("session_start", () => {
		recorder.sessionStart();
	});

	pi.on("input", () => {
		recorder.input();
		// A submitted message is the parent's reply — a pending ask is answered.
		awaitingAnswer = false;
	});

	pi.on("agent_start", () => {
		awaitingAnswer = false;
		recorder.agentStart();
	});

	pi.on("before_agent_start", () => {
		recorder.beforeAgentStart();
	});

	pi.on("turn_start", (event) => {
		recorder.turnStart((event as any).turnIndex);
	});
	pi.on("turn_end", (event) => {
		recorder.turnEnd((event as any).turnIndex);
	});
	pi.on("before_provider_request", () => {
		recorder.beforeProviderRequest();
	});
	pi.on("after_provider_response", () => {
		recorder.afterProviderResponse();
	});
	pi.on("message_update", (event) => {
		recorder.messageUpdate((event as any).assistantMessageEvent?.type);
	});
	pi.on("tool_execution_start", (event) => {
		recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
	});
	pi.on("tool_call", (event) => {
		recorder.toolCall((event as any).toolCallId, (event as any).toolName);
	});
	pi.on("tool_execution_update", (event) => {
		recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
	});
	pi.on("tool_result", (event) => {
		recorder.toolResult((event as any).toolCallId, (event as any).toolName);
	});
	pi.on("tool_execution_end", (event) => {
		recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
	});

	// Auto-exit: shut down on a normally-completed turn unless an ask is parked
	// or this session still has its own children running.
	pi.on("agent_end", (event, ctx) => {
		const messages = (event as any).messages as any[] | undefined;

		let lastAssistant: any = undefined;
		if (messages) {
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i]?.role === "assistant") {
					lastAssistant = messages[i];
					break;
				}
			}
		}
		const completedNormally = lastAssistant ? lastAssistant.stopReason !== "aborted" : true;
		const hasPendingChildren =
			typeof (globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] === "function" &&
			(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY]() > 0;

		const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
		if (autoExit && !awaitingAnswer && !hasPendingChildren && completedNormally) {
			// Surface provider errors (auto-retry exhausted) via .exit sidecar.
			if (lastAssistant?.stopReason === "error") {
				const raw = typeof lastAssistant.errorMessage === "string" ? lastAssistant.errorMessage.trim() : "";
				const sessionFile = process.env.PI_SUBAGENT_SESSION;
				if (sessionFile) {
					try {
						writeFileSync(
							`${sessionFile}.exit`,
							JSON.stringify({
								type: "error",
								errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
								stopReason: "error",
							}),
						);
					} catch {
						// best effort
					}
				}
			}
			recorder.agentEndDone();
			(ctx as any).shutdown();
			return;
		}

		recorder.agentEndWaiting();
	});

	pi.on("session_shutdown", (event) => {
		recorder.sessionShutdown((event as any).reason);
	});

	// Execution-level tool allowlist interceptor: schema filtering (--tools)
	// happens at listing time; this independently rejects anything else at
	// execution time. Fail-fast: the model gets an error immediately.
	pi.on("tool_call", (event) => {
		const allow = CHILD_TOOL_ALLOWLIST;
		if (!allow) return;
		const toolName = (event as any).toolName as string;
		if (FORBIDDEN_TOOLS.has(toolName)) {
			return {
				block: true,
				reason:
					`Tool "${toolName}" is a generic gateway and is not available to subagents. ` +
					`Allowed tools: ${[...allow].sort().join(", ")}.`,
			};
		}
		if (!allow.has(toolName)) {
			return {
				block: true,
				reason:
					`Tool "${toolName}" is not in this subagent's allowlist. ` +
					`Allowed tools: ${[...allow].sort().join(", ")}.`,
			};
		}
	});
}

// ── Extension entry ──────────────────────────────────────────────────────────

export default function subagentsExtension(pi: ExtensionAPI) {
	latestPi = pi;

	// Child role wiring (activity, auto-exit, interceptor).
	if (IS_SUBAGENT_PROCESS) {
		createChildRoleHandlers(pi);
	}

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
		if (!prevAbort || prevAbort.signal.aborted) {
			(globalThis as any)[POLL_ABORT_KEY] = new AbortController();
		}
		checkPermissionSystemCompat(ctx);
	});

	// Our integration with @gotgenes/pi-permission-system is contract-level (env
	// var, inbox dirs, config.json, per-agent frontmatter). Warn when the
	// installed version falls outside the range we validated against, so an
	// upstream change surfaces as a visible notice instead of silent breakage.
	const PERMISSION_SYSTEM_TESTED_MAJOR = 33;
	function checkPermissionSystemCompat(ctx: ExtensionContext): void {
		if (IS_SUBAGENT_PROCESS) return;
		try {
			const pkgPath = join(
				getAgentConfigDir(),
				"npm",
				"node_modules",
				"@gotgenes",
				"pi-permission-system",
				"package.json",
			);
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
			const major = Number.parseInt((pkg.version ?? "").split(".")[0] ?? "", 10);
			if (Number.isFinite(major) && major !== PERMISSION_SYSTEM_TESTED_MAJOR) {
				ctx.ui.notify(
					`Permission popups for subagents may not appear: the permission system was updated to v${pkg.version}, but this extension was tested with v${PERMISSION_SYSTEM_TESTED_MAJOR}.x. If a subagent stalls waiting for approval or reports "approval unavailable", update the subagents extension to match. `,
					"warning",
				);
			}
		} catch {
			// Not installed — permission features simply degrade to fail-closed denies.
		}
	}

	pi.on("session_shutdown", () => {
		stopTick();
		for (const running of runningSubagents.values()) {
			killChild(running.child);
		}
		runningSubagents.clear();
		latestCtx?.ui.setWidget("subagent-ribbon", undefined);
	});

	// Ribbon viewport navigation (no-ops while the ribbon is hidden or empty).
	pi.registerShortcut("alt+h", {
		description: "Subagent ribbon: focus previous pane",
		handler: () => {
			ribbonFocus = Math.max(0, ribbonFocus - 1);
			paneScroll = 0;
			updateWidget();
		},
	});
	pi.registerShortcut("alt+l", {
		description: "Subagent ribbon: focus next pane",
		handler: () => {
			ribbonFocus = Math.max(0, Math.min(buildRibbonEntries().length - 1, ribbonFocus + 1));
			paneScroll = 0;
			updateWidget();
		},
	});
	pi.registerShortcut("alt+e", {
		description: "Subagent ribbon: zoom focused pane (toggle)",
		handler: () => {
			ribbonZoom = !ribbonZoom;
			paneScroll = 0;
			updateWidget();
		},
	});
	pi.registerShortcut("alt+k", {
		description: "Subagent ribbon: scroll focused pane up in history",
		handler: () => {
			paneScroll = Math.min(paneScroll + 6, 400);
			updateWidget();
		},
	});
	pi.registerShortcut("alt+j", {
		description: "Subagent ribbon: scroll focused pane down in history",
		handler: () => {
			paneScroll = Math.max(0, paneScroll - 6);
			updateWidget();
		},
	});
	pi.registerShortcut("alt+e", {
		description: "Subagent ribbon: zoom focused pane (toggle)",
		handler: () => {
			ribbonZoom = !ribbonZoom;
			paneScroll = 0;
			updateWidget();
		},
	});
	pi.registerShortcut("alt+k", {
		description: "Subagent ribbon: scroll focused pane up in history",
		handler: () => {
			paneScroll = Math.min(paneScroll + 6, 400);
			updateWidget();
		},
	});
	pi.registerShortcut("alt+j", {
		description: "Subagent ribbon: scroll focused pane down in history",
		handler: () => {
			paneScroll = Math.max(0, paneScroll - 6);
			updateWidget();
		},
	});


	registerSubagentTool(pi);
	registerSubagentMessageTool(pi);
	registerSubagentsListTool(pi);
	registerAskUserTool(pi);
	registerCommandAndRenderers(pi);
	registerOrchestratorMode(pi);
}

// ── Orchestrator mode (opt-in workflow system prompt + footer status) ────────

const WORKFLOW_PATH = join(getAgentConfigDir(), "orchestrator-workflow.md");
let orchestratorMode = false;
let orchestratorWorkflowText: string | null = null;

function loadWorkflowText(): string {
	if (orchestratorWorkflowText === null) {
		try {
			orchestratorWorkflowText = readFileSync(WORKFLOW_PATH, "utf8").trim();
		} catch {
			orchestratorWorkflowText = "";
		}
	}
	return orchestratorWorkflowText;
}

/**
 * /orchestrator toggles the orchestrator workflow as an appended system
 * instruction for this session (footer shows the mode). Off by default.
 * Workflow text: ~/.pi/agent/orchestrator-workflow.md.
 */
function registerOrchestratorMode(pi: ExtensionAPI): void {
	if (IS_SUBAGENT_PROCESS) return; // child sessions never get this

	pi.registerCommand("orchestrator", {
		description: "Toggle orchestrator mode (workflow system prompt + footer status)",
		handler: async (_args, ctx) => {
			orchestratorMode = !orchestratorMode;
			if (orchestratorMode) {
				const text = loadWorkflowText();
				if (!text) {
					orchestratorMode = false;
					ctx.ui.notify(`Workflow file not found: ${WORKFLOW_PATH}`, "error");
					return;
				}
				ctx.ui.setStatus("mode", "orchestrator");
				ctx.ui.notify("Orchestrator mode ON — workflow appended to system prompt", "info");
			} else {
				ctx.ui.setStatus("mode", undefined);
				ctx.ui.notify("Orchestrator mode OFF", "info");
			}
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!orchestratorMode) return undefined;
		const workflow = loadWorkflowText();
		if (!workflow) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${workflow}` };
	});
}

// ── subagent tool ────────────────────────────────────────────────────────────

const SubagentParams = Type.Object({
	agent: Type.String({
		description:
			"Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents.",
	}),
	task: Type.String({ description: "Task/prompt for the sub-agent" }),
	name: Type.Optional(
		Type.String({
			description:
				"Optional cosmetic label for the subagent's box and status rows. Defaults to the agent name. Has no effect on which agent runs — use `agent` for that.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config and extensions.",
		}),
	),
});

function registerSubagentTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Spawn a sub-agent as a headless background process. " +
			"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
			"When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
			"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
			"DO NOT fabricate, assume, or summarize results after calling this tool. " +
			"After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
		promptSnippet:
			"Spawn a headless sub-agent. Fire-and-forget: result arrives automatically as a steer message. Do not poll or fabricate results.",
		promptGuidelines: [
			"Spawn a subagent when a task fits an available agent profile (recon, research, implementation).",
			"The call returns immediately; the result is delivered to you automatically later as a steer message.",
			"Never poll, sleep, or read session files to check on a running subagent.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			dbg(`subagent tool execute: ${JSON.stringify(params)}`);
			// Prevent self-spawning.
			const currentAgent = process.env.PI_SUBAGENT_AGENT;
			if (params.agent && currentAgent && params.agent === currentAgent) {
				return {
					content: [
						{
							type: "text",
							text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
						},
					],
					details: { error: "self-spawn blocked" },
				};
			}

			const permittedAgents = SUBAGENT_ALLOWLIST
				? [...SUBAGENT_ALLOWLIST]
				: discoverAgentDefinitions().map((a) => a.name);
			const permittedSet = new Set(permittedAgents);
			const permittedList = permittedAgents.join(", ") || "(none)";

			if (!params.agent) {
				return {
					content: [
						{
							type: "text",
							text: `You must specify which agent to spawn via the "agent" field. Available agents: ${permittedList}.`,
						},
					],
					details: { error: "agent required" },
				};
			}
			if (!permittedSet.has(params.agent)) {
				return {
					content: [
						{
							type: "text",
							text:
								`You may not spawn the "${params.agent}" agent — it is not ` +
								`${SUBAGENT_ALLOWLIST ? "in your allowlist" : "a known agent"}. ` +
								`Available agents: ${permittedList}.`,
						},
					],
					details: {
						error: SUBAGENT_ALLOWLIST ? "agent not in allowlist" : "unknown agent",
					},
				};
			}

			if (!ctx.sessionManager.getSessionFile()) {
				return {
					content: [
						{
							type: "text",
							text: "Error: no session file. Start pi with a persistent session to use subagents.",
						},
					],
					details: { error: "no session file" },
				};
			}

			const parentArtifactDir = getArtifactDir(
				ctx.sessionManager.getSessionDir(),
				ctx.sessionManager.getSessionId(),
			);

			let reservedName: string | null = null;
			if (!params.name?.trim()) {
				const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
				params.name = uniqueRunningName(params.agent ?? "subagent", registryNames);
				reservedName = params.name;
				reservedNames.add(reservedName);
			}

			let running: RunningSubagent;
			try {
				running = await launchSubagent(params, ctx);
			} catch (err: any) {
				if (reservedName) reservedNames.delete(reservedName);
				const msg = `Failed to launch subagent: ${err?.message ?? String(err)}`;
				return { content: [{ type: "text", text: msg }], details: { error: msg } };
			} finally {
				if (reservedName) reservedNames.delete(reservedName);
			}

			dbg(`registered ${running.name}`);
			registerName(parentArtifactDir, running.name, {
				sessionFile: running.sessionFile,
				sessionId: getSessionId(running.sessionFile),
			});

			startTick(pi);
			updateWidget();

			return {
				content: [
					{
						type: "text",
						text:
							`Sub-agent "${params.name}" launched and is now running in the background. ` +
							`Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
							`The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
							`Until then, move on to other work or tell the user you're waiting.`,
					},
				],
				details: {
					id: running.id,
					name: params.name,
					task: params.task,
					agent: params.agent,
					sessionFile: running.sessionFile,
					status: "started",
				},
			};
		},

		renderCall(args, theme) {
			const partialArgs = args as Record<string, unknown>;
			const agentName = typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
			const name =
				typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : agentName || "(unnamed)";
			const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
			const agent = agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
			let text = "○ " + theme.fg("toolTitle", theme.bold(name)) + agent;
			if (task) {
				const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
				const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
				if (preview) text += `\n${theme.fg("toolOutput", preview)}`;
				const totalLines = task.split("\n").length;
				if (totalLines > 1) text += theme.fg("muted", ` (${totalLines} lines)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as any;
			const name = details?.name ?? "(unnamed)";
			if (details?.status === "started") {
				return new Text(
					theme.fg("accent", "⟳") + " " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — started"),
					0,
					0,
				);
			}
			const first = result.content[0] as any;
			const text = typeof first?.text === "string" ? first.text : "";
			return new Text(theme.fg("dim", text), 0, 0);
		},
	});
}

// ── subagents_list tool ──────────────────────────────────────────────────────

function registerSubagentsListTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagents_list",
		label: "List Subagents",
		description:
			"List all available subagent definitions. Scans .pi/agents/, ./agents/ and ~/.pi/agent/agents/. Project-local agents override global ones with the same name.",
		promptSnippet: "List all available subagent definitions.",
		parameters: Type.Object({}),

		async execute() {
			const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);
			if (list.length === 0) {
				return { content: [{ type: "text", text: "No subagent definitions found." }], details: { agents: [] } };
			}
			const lines = list.map((a) => {
				const badge = a.source === "project" ? " (project)" : "";
				const desc = a.description ? ` — ${a.description}` : "";
				const model = a.model ? ` [${a.model}]` : "";
				return `• ${a.name}${badge}${model}${desc}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: { agents: list } };
		},

		renderResult(result, _opts, theme) {
			const details = result.details as any;
			const agents = details?.agents ?? [];
			if (agents.length === 0) {
				return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
			}
			const lines = agents.map((a: any) => {
				const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
				const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
				const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
				return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

// ── subagent_message tool ────────────────────────────────────────────────────

function registerSubagentMessageTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent_message",
		label: "Message Subagent",
		description:
			"Send a message to a subagent by name. Names are unique within your session and persist after a subagent finishes, " +
			"so the SAME name works whether the subagent is running or finished: if it is still running, your message steers its live session " +
			"(or answers a pending ask_user question); if it has finished, your message resumes that session and continues it. " +
			"`name` and `message` are both required. " +
			"Steering a running subagent returns immediately and does NOT, by itself, emit a new result. " +
			"Resuming is a fire-and-forget async call: when the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message. " +
			"DO NOT poll, sleep, tail logs, or read session files to detect completion — the harness handles delivery. " +
			"DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.",
		promptSnippet:
			"Message a subagent by name: answers a pending ask_user question, steers it if running, resumes it if finished (same name either way).",
		parameters: Type.Object({
			name: Type.String({
				description:
					"Exact display name of the subagent. Steers it if it is still running; resumes its session if it has finished.",
			}),
			message: Type.String({
				description:
					"The message to deliver: the answer to its pending question, a follow-up instruction for a running subagent, or the next task for a resumed session.",
			}),
		}),

		renderCall(args, theme) {
			const target = args.name ?? "(unknown)";
			return new Text("○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"), 0, 0);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as any;
			if (details?.status === "answered") {
				return new Text(
					theme.fg("success", "✓") + " " + theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
						theme.fg("dim", " — answer delivered"),
					0,
					0,
				);
			}
			if (details?.status === "steered") {
				return new Text(
					theme.fg("success", "✓") + " " + theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
						theme.fg("dim", " — message delivered"),
					0,
					0,
				);
			}
			if (details?.status === "started") {
				return new Text(
					theme.fg("accent", "⟳") + " " + theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
						theme.fg("dim", " — resumed"),
					0,
					0,
				);
			}
			const first = result.content[0] as any;
			const text = typeof first?.text === "string" ? first.text : "";
			return new Text(theme.fg("dim", text), 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requestedName = params.name?.trim();
			if (!requestedName) {
				const err = "Provide the subagent's `name` to steer (if running) or resume (if finished).";
				return { content: [{ type: "text", text: err }], details: { error: err } };
			}

			// ── Answer a pending ask_user ──
			const runningMatch = Array.from(runningSubagents.values()).find((r) => r.name === requestedName);
			if (runningMatch?.pendingAsk) {
				const payload = runningMatch.pendingAsk;
				const response = parseAskReply(params.message, {
					options: payload.options,
					allowMultiple: payload.allowMultiple,
				});
				try {
					writeFileSync(`${runningMatch.sessionFile}.reply`, JSON.stringify({ response }), "utf8");
				} catch (err: any) {
					const msg = `Failed to deliver answer: ${err?.message ?? String(err)}`;
					return { content: [{ type: "text", text: msg }], details: { error: msg } };
				}
				runningMatch.pendingAsk = undefined;
				return {
					content: [
						{
							type: "text",
							text:
								`Answer delivered to "${requestedName}". Its ask_user call resolves with your reply and it continues from where it paused.`,
						},
					],
					details: { name: requestedName, status: "answered", response },
				};
			}

			// ── Steer a running subagent ──
			if (runningMatch) {
				try {
					await sendMessageToChild(runningMatch.child, params.message);
				} catch (err: any) {
					const msg = `Failed to deliver message to subagent "${runningMatch.name}": ${err?.message ?? String(err)}`;
					return { content: [{ type: "text", text: msg }], details: { error: msg, name: runningMatch.name } };
				}
				runningMatch.statusState = forceStatusAfterInterrupt(runningMatch.statusState, Date.now());
				updateWidget();
				return {
					content: [
						{
							type: "text",
							text: `Message delivered to running subagent "${runningMatch.name}". It picks this up at its next turn boundary.`,
						},
					],
					details: { id: runningMatch.id, name: runningMatch.name, status: "steered" },
				};
			}

			// ── Resume a finished session by name ──
			const parentArtifactDir = getArtifactDir(
				ctx.sessionManager.getSessionDir(),
				ctx.sessionManager.getSessionId(),
			);
			const entry = resolveNameInRegistry(parentArtifactDir, requestedName);
			if (!entry) {
				const known = Object.keys(readNameRegistry(parentArtifactDir));
				const err =
					`No subagent named "${requestedName}" in this session. ` +
					(known.length > 0
						? `Known subagents: ${known.join(", ")}.`
						: "No subagents have been spawned in this session yet.");
				return { content: [{ type: "text", text: err }], details: { error: err } };
			}

			const sessionPath = entry.sessionFile;
			if (!sessionPath || !existsSync(sessionPath)) {
				const err = `Subagent "${requestedName}" is registered but its session file is gone (${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`;
				return { content: [{ type: "text", text: err }], details: { error: err } };
			}

			// Never resume a session that is still running — two processes writing
			// one .jsonl corrupts it.
			for (const r of runningSubagents.values()) {
				if (resolve(r.sessionFile) === resolve(sessionPath)) {
					try {
						await sendMessageToChild(r.child, params.message);
					} catch (err: any) {
						const msg = `Failed to deliver message: ${err?.message ?? String(err)}`;
						return { content: [{ type: "text", text: msg }], details: { error: msg, name: r.name } };
					}
					return {
						content: [
							{ type: "text", text: `Subagent "${requestedName}" is still running — your message was delivered as a steer.` },
						],
						details: { name: r.name, status: "steered" },
					};
				}
			}

			const loadout = readSubagentLoadout(sessionPath);
			if (!loadout) {
				const err =
					`Cannot safely resume "${requestedName}": no loadout snapshot found for this session. ` +
					`Re-run the task as a fresh subagent instead.`;
				return { content: [{ type: "text", text: err }], details: { error: err } };
			}

			const startTime = Date.now();
			const id = Math.random().toString(16).slice(2, 10);
			const entryCountBefore = countSessionEntryLines(sessionPath);
			const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
			const activityFile = getSubagentActivityFile(artifactDir, id);
			mkdirSync(dirname(activityFile), { recursive: true });

			const args: string[] = ["-a", "--mode", "rpc", "--session", sessionPath];
			if (loadout.model) {
				args.push("--model", loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model);
			}
			if (loadout.identity) {
				args.push(loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", loadout.identity);
			}
			if (loadout.toolAllowlist) args.push("--tools", loadout.toolAllowlist);
			if (resolve(loadout.cwd ?? process.cwd()) !== resolve(process.cwd())) {
				args.push("-e", THIS_FILE);
			}

			const env: NodeJS.ProcessEnv = {};
			if (loadout.agentDir) env.PI_CODING_AGENT_DIR = loadout.agentDir;
			else if (process.env.PI_CODING_AGENT_DIR) env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
			if (loadout.spawnable && loadout.spawnable.length > 0) env.PI_SUBAGENT_ALLOWED = loadout.spawnable.join(",");
			if (loadout.agent) env.PI_SUBAGENT_AGENT = loadout.agent;
			env.PI_SUBAGENT_NAME = requestedName;
			env.PI_SUBAGENT_SESSION = sessionPath;
			env.PI_SUBAGENT_ID = id;
			env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
			env.PI_SUBAGENT_AUTO_EXIT = "1"; // resumes are always autonomous
			if (loadout.toolAllowlist) env.PI_SUBAGENT_TOOL_ALLOWLIST = loadout.toolAllowlist;
			env.PI_SUBAGENT_PARENT_SESSION = rootParentSessionId(ctx);
			env.PI_BLACKHOLE_PASSIVE = "1";

			const child = spawnRpcChild({
				id,
				args,
				env,
				cwd: loadout.cwd ?? process.cwd(),
				sessionFile: sessionPath,
				onExit: () => {
					const r = runningSubagents.get(id);
					if (r) finishRunningSubagent(r);
				},
			});

			const running: RunningSubagent = {
				id,
				name: requestedName,
				task: params.message,
				agent: loadout.agent ?? undefined,
				child,
				startTime,
				sessionFile: sessionPath,
				entryCountBefore,
				activityFile,
				interactive: false,
				statusState: createStatusState({ startTimeMs: startTime }),
			};
			runningSubagents.set(id, running);

			try {
				await rpcCommand(child, { type: "prompt", message: params.message });
			} catch (err) {
				child.lastError = err instanceof Error ? err.message : String(err);
			}

			startTick(pi);
			updateWidget();

			return {
				content: [{ type: "text", text: `Session "${requestedName}" resumed.` }],
				details: { id, name: requestedName, sessionId: entry.sessionId, sessionFile: sessionPath, status: "started" },
			};
		},
	});
}

// ── unified ask_user tool ────────────────────────────────────────────────────

const AskParams = Type.Object({
	question: Type.String({ description: "The question to ask" }),
	context: Type.Optional(
		Type.String({ description: "Relevant context to show before the question (summary of findings)" }),
	),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String({ description: "Short title for this option" }),
				description: Type.Optional(Type.String({ description: "Longer description explaining this option" })),
			}),
			{ description: "List of options to choose from" },
		),
	),
	allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
	allowFreeform: Type.Optional(Type.Boolean({ description: "Allow a freeform text answer. Default: true" })),
	allowComment: Type.Optional(
		Type.Boolean({ description: "Collect an optional comment after selection. Default: false." }),
	),
	displayMode: Type.Optional(
		Type.Unsafe<string>({ type: "string", enum: ["overlay", "inline"], description: "UI rendering mode (interactive branch only). Default: overlay." }),
	),
	overlayToggleKey: Type.Optional(
		Type.String({ description: "Shortcut for hiding/showing the overlay popup (interactive branch only). Default: alt+o." }),
	),
	commentToggleKey: Type.Optional(
		Type.String({ description: "Shortcut for toggling the optional comment row (interactive branch only). Default: ctrl+g." }),
	),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Auto-dismiss after N milliseconds. In subagent context: resolves with no answer (null) when the parent hasn't replied in time, instead of parking forever.",
		}),
	),
});

function registerAskUserTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask a question and pause until it is answered. In a top-level (human-attended) session this opens an interactive question UI. " +
			"In a subagent context the question is forwarded to the parent orchestrator: your session stays open while you wait and the answer arrives as this tool's result. " +
			"Ask exactly one focused question per call. Before calling, gather context with tools and pass a short summary via the context field.",
		promptSnippet:
			"Ask one focused question with optional multiple-choice answers and pause for the reply. Prefer asking over guessing.",
		promptGuidelines: [
			"Ask exactly one question per call; make separate calls for unrelated questions.",
			"Use it when requirements, preferences, or decisions are unclear — instead of guessing.",
			"Give enough context in the question that the answerer can respond without re-reading your whole task.",
			"After asking, stop and wait — the reply arrives as this tool's result.",
		],
		executionMode: "sequential",
		parameters: AskParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Branch on process role, not on UI availability — same schema, same
			// result shape, callers never need to know which branch ran.
			if (IS_SUBAGENT_PROCESS) {
				return askUserViaSidecar(pi, params as any, signal);
			}
			return runInteractiveAsk(pi, ctx as any, params as any, signal, onUpdate) as any;
		},

		renderCall(args, theme) {
			const question = (args.question as string) || "";
			const rawOptions = Array.isArray(args.options) ? args.options : [];
			let text = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", question);
			if (rawOptions.length > 0) {
				const labels = rawOptions.map((o: any) => o?.title ?? "<invalid>");
				text += `\n${theme.fg("dim", `  ${rawOptions.length} option(s): ${labels.join(", ")}`)}`;
			}
			if (args.allowMultiple) text += theme.fg("dim", " [multi-select]");
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (details?.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			if (options.isPartial) {
				const waitingText =
					result.content?.map((p: any) => (p.type === "text" ? p.text : "")).join("\n").trim() ||
					"Waiting for an answer...";
				return new Text(theme.fg("muted", waitingText), 0, 0);
			}
			if (!details || details.cancelled || !details.response) {
				return new Text(theme.fg("warning", "Cancelled / no answer"), 0, 0);
			}
			const response = details.response;
			let text = theme.fg("success", "✓ ");
			if (response.kind === "freeform") text += theme.fg("muted", "(wrote) ");
			text += theme.fg(
				"accent",
				response.kind === "selection" ? response.selections.join(", ") : response.text,
			);
			if (options.expanded && details.question) {
				text += `\n${theme.fg("dim", `Q: ${details.question}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}

/**
 * Branch B — subagent context. Write a `.ask` sidecar carrying the full param
 * set, park (auto-exit suppressed via awaitingAnswer + activity "waiting"),
 * the parent's watcher delivers the question as a steer notification, and the
 * parent replies via subagent_message which writes our `.reply` sidecar. The
 * tool call itself blocks until the reply lands or `timeout` (ms) expires —
 * resolving with no answer (null semantics) rather than parking forever.
 */
async function askUserViaSidecar(
	pi: ExtensionAPI,
	params: {
		question: string;
		context?: string;
		options?: Array<{ title: string; description?: string }>;
		allowMultiple?: boolean;
		allowFreeform?: boolean;
		allowComment?: boolean;
		timeout?: number;
	},
	signal?: AbortSignal,
): Promise<any> {
	const sessionFile = process.env.PI_SUBAGENT_SESSION;
	if (!sessionFile) {
		// Should be unreachable (IS_SUBAGENT_PROCESS implies this env var).
		throw new Error("ask_user subagent branch requires PI_SUBAGENT_SESSION.");
	}

	const askData = {
		name: process.env.PI_SUBAGENT_NAME ?? "subagent",
		agent: process.env.PI_SUBAGENT_AGENT ?? "",
		question: params.question,
		...(params.context ? { context: params.context } : {}),
		...(params.options && params.options.length > 0 ? { options: params.options } : {}),
		...(params.allowMultiple ? { allowMultiple: true } : {}),
		...(params.allowFreeform === false ? { allowFreeform: false } : {}),
		...(params.allowComment ? { allowComment: true } : {}),
		...(params.timeout ? { timeout: params.timeout } : {}),
	};

	// displayMode / overlayToggleKey / commentToggleKey: accepted, silently
	// ignored — nothing renders in a headless child.
	awaitingAnswer = true;
	const replyFile = `${sessionFile}.reply`;
	try {
		if (existsSync(replyFile)) unlinkSync(replyFile); // stale reply from earlier
	} catch {}
	writeFileSync(`${sessionFile}.ask`, JSON.stringify(askData), "utf8");

	const pollMs = 250;
	const deadline = params.timeout && params.timeout > 0 ? Date.now() + params.timeout : null;

	const cleanupSidecars = (timedOut: boolean): void => {
		try {
			if (existsSync(`${sessionFile}.ask`)) unlinkSync(`${sessionFile}.ask`);
			if (timedOut) writeFileSync(`${sessionFile}.ask-timeout`, "", "utf8");
		} catch {}
		awaitingAnswer = false;
	};

	while (true) {
		if (signal?.aborted) {
			cleanupSidecars(false);
			return {
				content: [{ type: "text", text: "Cancelled" }],
				details: { question: params.question, options: params.options ?? [], response: null, cancelled: true },
			};
		}

		if (existsSync(replyFile)) {
			let parsed: any = null;
			try {
				parsed = JSON.parse(readFileSync(replyFile, "utf8"));
			} catch {}
			try {
				unlinkSync(replyFile);
			} catch {}
			const response = parsed?.response ?? null;
			cleanupSidecars(false);
			if (!response) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					details: { question: params.question, options: params.options ?? [], response: null, cancelled: true },
				};
			}
			const summary =
				response.kind === "selection" ? response.selections.join(", ") : String(response.text ?? "");
			return {
				content: [{ type: "text", text: `Orchestrator answered: ${summary}` }],
				details: {
					question: params.question,
					context: params.context,
					options: params.options ?? [],
					response,
					cancelled: false,
				},
			};
		}

		if (deadline !== null && Date.now() >= deadline) {
			// Timed out: mark it so the parent stops holding a pending question, and
			// resolve with no answer (matches the real package's timeout semantics)
			// instead of parking forever.
			cleanupSidecars(true);
			return {
				content: [
					{
						type: "text",
						text: "No reply arrived in time (timeout). No answer was received — proceed with your best judgment or adapt your plan.",
					},
				],
				details: {
					question: params.question,
					context: params.context,
					options: params.options ?? [],
					response: null,
					cancelled: true,
				},
			};
		}

		await new Promise((r) => setTimeout(r, pollMs));
	}
}

// ── Command + message renderers ──────────────────────────────────────────────

export function walkSubagentTree(artifactDir: string, prefix: string, out: string[], depth: number): void {
	if (depth > 4) return;
	const registry = readNameRegistry(artifactDir);
	// Registry key order is race-order (parallel spawns), not spawn order.
	// Sort children by the session filename's spawn timestamp.
	const names = Object.keys(registry).sort(
		(a, b) =>
			sessionSpawnTime(registry[a]?.sessionFile ?? "") - sessionSpawnTime(registry[b]?.sessionFile ?? ""),
	);
	names.forEach((name, i) => {
		const entry = registry[name];
		const last = i === names.length - 1;
		const branch = `${last ? "└─ " : "├─ "}`;
		const stats = entry.sessionFile && existsSync(entry.sessionFile) ? summarizeSessionStats(entry.sessionFile) : null;
		const detail = stats
			? `${stats.toolCount} tools${stats.cost ? `, $${stats.cost.toFixed(3)}` : ""}${stats.model ? `, ${stats.model}` : ""}`
			: "(session file missing)";
		out.push(`${prefix}${branch}${name}${detail ? ` — ${detail}` : ""}`);
		if (entry.sessionFile && existsSync(entry.sessionFile)) {
			out.push(`${prefix}${last ? "   " : "│  "}   session: ${entry.sessionFile}`);
			const sid = entry.sessionId ?? getSessionId(entry.sessionFile);
			if (sid) {
				walkSubagentTree(
					join(dirname(entry.sessionFile), "artifacts", sid),
					`${prefix}${last ? "   " : "│  "}`,
					out,
					depth + 1,
				);
			}
		}
	});
}

function registerCommandAndRenderers(pi: ExtensionAPI) {
	// /subagent-tree — print the spawn tree (live + past) with session paths,
	// stats, and costs. Persisted as a custom ENTRY (not a message): visible in
	// the transcript for the human, but never sent to the LLM (no context cost).
	pi.registerCommand("subagent-tree", {
		description: "Print the subagent spawn tree with session paths and stats",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
			const out: string[] = [`Subagent tree (session ${sessionId}):`];
			walkSubagentTree(artifactDir, "", out, 0);
			if (out.length === 1) out.push("(no subagents spawned from this session)");
			pi.appendEntry("subagent_tree", { lines: out });
		},
	});

	pi.registerEntryRenderer("subagent_tree", (entry) => {
		const data = entry.data as { lines?: string[] } | undefined;
		const lines = Array.isArray(data?.lines) ? data.lines : [];
		return {
			invalidate() {},
			render(width: number): string[] {
				return ["", ...lines.map((line) => line.slice(0, Math.max(1, width - 2)))];
			},
		};
	});


	pi.registerCommand("subagent", {
		description: "Spawn a subagent: /subagent <agent> <task>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
				return;
			}
			const spaceIdx = trimmed.indexOf(" ");
			const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
			const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
			const defs = loadAgentDefaults(agentName);
			if (!defs) {
				ctx.ui.notify(`Agent "${agentName}" not found in .pi/agents/, ./agents/ or ~/.pi/agent/agents/`, "error");
				return;
			}
			const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
			const displayName = agentName[0].toUpperCase() + agentName.slice(1);
			pi.sendUserMessage(
				`Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`,
			);
		},
	});

	pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
		const details = message.details as any;
		if (!details) return undefined;
		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const exitCode = details.exitCode ?? 0;
				const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
				const failed = exitCode !== 0 || !!errorMessage;
				const elapsed = details.elapsed != null ? formatElapsedShort(details.elapsed) : "?";
				const bgFn = failed
					? (text: string) => theme.bg("toolErrorBg", text)
					: (text: string) => theme.bg("toolSuccessBg", text);
				const stats = (details.stats ?? null) as SessionStats | null;
				const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
				const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
				const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

				let header: string;
				if (failed) {
					const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
					header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
				} else {
					const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
					header = `${titleSegment}${theme.fg("dim", toolPart)}`;
				}

				let usageLine: string | null = null;
				if (stats) {
					const segs: string[] = [];
					if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
					if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
					if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
					if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
					if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
					const dimSegs = segs.map((s) => theme.fg("dim", s));
					if (stats.contextTokens > 0) dimSegs.push(theme.fg("dim", `${formatTokens(stats.contextTokens)} ctx`));
					if (dimSegs.length > 0) usageLine = dimSegs.join(theme.fg("dim", " "));
				}

				const rawContent = typeof message.content === "string" ? message.content : "";
				const summary = rawContent
					.replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
					.replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
					.replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "");

				const contentLines = [header];
				if (usageLine) contentLines.push(usageLine);

				if (options.expanded) {
					if (summary) for (const line of summary.split("\n")) contentLines.push(line.slice(0, width - 6));
					if (details.name || details.sessionFile) {
						contentLines.push("");
						if (details.name) {
							contentLines.push(
								theme.fg("dim", `Follow up:  subagent_message({ name: "${details.name}", message: "…" })`),
							);
						}
						if (details.sessionFile) {
							contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
						}
					}
				} else {
					if (summary) {
						const previewLines = summary.split("\n").slice(0, 5);
						for (const line of previewLines) contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
						const totalLines = summary.split("\n").length;
						if (totalLines > 5) contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
					}
					contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
				}

				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
		const details = message.details as any;
		const lines = Array.isArray(details?.lines) ? details.lines : [];
		const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
		if (lines.length === 0 && overflow === 0) return undefined;
		return {
			invalidate() {},
			render(width: number): string[] {
				const lineWidth = Math.max(0, width - 6);
				const contentLines = [
					`${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
					...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
				];
				if (overflow > 0) contentLines.push(theme.fg("muted", `+${overflow} more running.`));
				if (!options.expanded) contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
				const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
		const details = message.details as any;
		if (!details) return undefined;
		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
				const bgFn = (text: string) => theme.bg("toolSuccessBg", text);
				const icon = theme.fg("accent", "?");
				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`;
				const contentLines = [header];
				if (options.expanded) {
					contentLines.push("");
					contentLines.push(details.question ?? "");
					contentLines.push("");
					contentLines.push(theme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`));
				} else {
					const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
					contentLines.push(theme.fg("dim", preview));
					contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
				}
				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});
}

function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}
