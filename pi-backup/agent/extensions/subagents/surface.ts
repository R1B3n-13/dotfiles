// Surface layer: spawns each subagent as its own `pi --mode rpc` child
// process and drives it over the RPC protocol (JSON lines on stdin/stdout).
// Replaces tmux.ts entirely: no multiplexer, no pty, no terminal emulation —
// box content comes from structured RPC events, steering from `steer`/`prompt`
// commands, completion from child-process exit.
import { spawn, type ChildProcess } from "node:child_process";

/** Maximum display lines retained per subagent buffer. */
const MAX_BUFFER_LINES = 400;

export interface RpcChildEvent {
	type: string;
	[key: string]: unknown;
}

export interface RpcChild {
	id: string;
	proc: ChildProcess;
	sessionFile: string;
	/** Rolling display buffer (most recent last) assembled from RPC events. */
	/** Full-fidelity buffer (untruncated args/results/thinking) for zoom mode. */
	fullLines: string[];
	lines: string[];
	/** True while the child's agent loop is running (agent_start..agent_settled). */
	busy: boolean;
	exited: boolean;
	exitCode: number | null;
	/** Last error text seen (extension_error / stderr tail / spawn failure). */
	lastError: string | null;
	/** Un-flushed thinking text (flushed per line / at ~120 chars). */
	thinkingBuf?: string;
}

interface SpawnRpcChildOptions {
	id: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	sessionFile: string;
	onEvent?: (child: RpcChild, event: RpcChildEvent) => void;
	onExit?: (child: RpcChild, code: number | null) => void;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Spawn a `pi --mode rpc` child. The caller sends the initial task via
 * `rpcCommand(child, { type: "prompt", message })` after this resolves.
 *
 * Any extension UI dialog request arriving on stdout (select/confirm/input/
 * editor) is auto-cancelled: headless children have nobody to answer dialogs,
 * and a hung wait is worse than a cancelled call. Permission asks are expected
 * to travel the filesystem-forwarding path instead (PI_SUBAGENT_PARENT_SESSION).
 */
export function spawnRpcChild(opts: SpawnRpcChildOptions): RpcChild {
	const child: RpcChild = {
		id: opts.id,
		proc: null as unknown as ChildProcess,
		sessionFile: opts.sessionFile,
		lines: [],
		fullLines: [],
		busy: false,
		exited: false,
		exitCode: null,
		lastError: null,
	};

	const proc = spawn("pi", opts.args, {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.proc = proc;

	let stdoutRest = "";
	proc.stdout?.setEncoding("utf8");
	proc.stdout?.on("data", (chunk: string) => {
		stdoutRest += chunk;
		let nl: number;
		// Strict LF framing per rpc.md (readline splits on U+2028/2029 too).
		while ((nl = stdoutRest.indexOf("\n")) !== -1) {
			const line = stdoutRest.slice(0, nl).replace(/\r$/, "");
			stdoutRest = stdoutRest.slice(nl + 1);
			if (!line.trim()) continue;
			let parsed: RpcChildEvent | null = null;
			try {
				parsed = JSON.parse(line) as RpcChildEvent;
			} catch {
				continue; // non-JSON noise — ignore
			}
			if (!parsed || typeof parsed.type !== "string") continue;
			handleChildLine(child, parsed, opts.onEvent);
		}
	});

	let stderrTail: string[] = [];
	proc.stderr?.setEncoding("utf8");
	proc.stderr?.on("data", (chunk: string) => {
		stderrTail.push(chunk);
		if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20);
	});

	proc.on("error", (err) => {
		child.lastError = err.message;
	});
	proc.on("exit", (code) => {
		child.exited = true;
		child.exitCode = code;
		const stderr = stderrTail.join("").trim();
		if (stderr && (code ?? 1) !== 0 && !child.lastError) {
			child.lastError = stderr.split("\n").slice(-3).join("\n");
		}
		opts.onExit?.(child, code);
	});

	return child;
}

function handleChildLine(
	child: RpcChild,
	event: RpcChildEvent,
	onEvent?: (child: RpcChild, event: RpcChildEvent) => void,
): void {
	// Auto-cancel any extension dialog request — see spawnRpcChild docstring.
	if (event.type === "extension_ui_request" && DIALOG_METHODS.has(String(event.method ?? ""))) {
		const id = event.id;
		if (typeof id === "string") {
			rpcWrite(child, { type: "extension_ui_response", id, cancelled: true });
		}
		return;
	}
	if (event.type === "response") {
		if (typeof event.id === "string") dispatchResponse(event.id, event);
		return;
	}

	trackDisplayState(child, event);
	if (child.lines.length > MAX_BUFFER_LINES) {
		child.lines = child.lines.slice(-MAX_BUFFER_LINES);
	}
	if (child.fullLines.length > MAX_FULL_BUFFER_LINES) {
		child.fullLines = child.fullLines.slice(-MAX_FULL_BUFFER_LINES);
	}
	onEvent?.(child, event);
}

function rpcWrite(child: RpcChild, payload: Record<string, unknown>): void {
	if (child.exited) return;
	try {
		child.proc.stdin?.write(`${JSON.stringify(payload)}\n`);
	} catch {
		// child gone — ignore
	}
}

/** Update busy flag + display buffer from an RPC event. */
export function trackDisplayState(child: RpcChild, event: RpcChildEvent): void {
	switch (event.type) {
		case "agent_start":
			child.busy = true;
			return;
		case "agent_settled":
			child.busy = false;
			return;
		case "agent_end":
			// agent_end can precede queued continuations; agent_settled marks idle.
			flushThinking(child);
			return;
	}

	const ame = event.assistantMessageEvent as
		| { type?: string; delta?: string; content?: string; toolName?: string }
		| undefined;
	if (event.type === "message_update" && ame) {
		if (ame.type === "text_delta" && typeof ame.delta === "string") {
			appendStreamingText(child, ame.delta);
		} else if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
			appendThinking(child, ame.delta);
		} else if (ame.type === "toolcall_start" && typeof ame.toolName === "string") {
			pushLine(child, `→ ${ame.toolName}`);
		}
		return;
	}

	if (event.type === "tool_execution_start") {
		const toolName = String(event.toolName ?? "");
		const shortSummary = summarizeToolArgs(toolName, event.args, 60);
		const fullSummary = summarizeToolArgs(toolName, event.args, 2000);
		const shortRich = `→ ${toolName}${shortSummary ? `: ${shortSummary}` : ""}`;
		const fullRich = `→ ${toolName}${fullSummary ? `: ${fullSummary}` : ""}`;
		// Upgrade the bare `→ toolName` placeholder emitted at toolcall_start.
		if (child.lines[child.lines.length - 1] === `→ ${toolName}`) child.lines[child.lines.length - 1] = shortRich;
		else pushShort(child, shortRich);
		if (child.fullLines[child.fullLines.length - 1] === `→ ${toolName}`) child.fullLines[child.fullLines.length - 1] = fullRich;
		else pushFull(child, fullRich);
		return;
	}

	if (event.type === "tool_execution_end") {
		const toolName = String(event.toolName ?? "");
		const icon = event.isError === true ? "✗" : "←";
		const short = summarizeToolResult(event.result);
		if (short) pushShort(child, `${icon} ${toolName}: ${short}`);
		const full = summarizeToolResultLines(event.result, RESULT_MAX_LINES);
		if (full.length > 0) {
			pushFull(child, `${icon} ${toolName}: ${full[0]}`);
			for (let i = 1; i < full.length; i++) pushFull(child, `  ${full[i]}`);
		}
		return;
	}

	if (event.type === "auto_retry_start") {
		pushLine(child, "⟳ retrying…");
	}
}

/** Argument fields worth showing, by tool name. */
const TOOL_ARG_KEYS: Record<string, string[]> = {
	bash: ["command"],
	read: ["file_path", "path"],
	write: ["file_path", "path"],
	edit: ["file_path", "path"],
	replace: ["file_path", "path"],
	insert: ["file_path", "path"],
	grep: ["pattern", "path"],
	find: ["pattern", "path"],
	ls: ["path"],
	web_fetch: ["url"],
	web_search: ["query", "searches"],
	subagent: ["agent", "task"],
	ask_user: ["question"],
	subagent_message: ["name", "message"],
};

const THINKING_FLUSH_CHARS = 120;

/** Short human summary of a tool call's primary argument. */
export function summarizeToolArgs(toolName: string, args: unknown, maxLen = 60): string {
	if (args === null || args === undefined || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const cap = (text: string): string => (text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text);
	const keys = TOOL_ARG_KEYS[toolName] ?? Object.keys(record);
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			return cap(value.trim().split("\n")[0]);
		}
		if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
			return value.length > 1 ? `${value[0]} (+${value.length - 1} more)` : value[0];
		}
	}
	// Generic fallback: stringify the first non-empty value (arrays/objects).
	for (const value of Object.values(record)) {
		if (value === null || value === undefined) continue;
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (text && text !== "{}" && text !== "[]") return cap(text);
	}
	return "";
}

/** First meaningful text line of a tool result, truncated. */
export function summarizeToolResult(result: unknown): string {
	const lines = summarizeToolResultLines(result, 1, 80);
	return lines[0] ?? "";
}

/** Result text lines (up to `maxLines`), with an ellipsis marker when cut. */
export function summarizeToolResultLines(result: unknown, maxLines: number, maxLenPerLine = 400): string[] {
	try {
		const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
		if (!Array.isArray(content)) return [];
		const all: string[] = [];
		for (const part of content) {
			if (typeof part?.text === "string" && part.text.trim()) {
				for (const line of part.text.trim().split("\n")) {
					const t = line.replace(/\s+$/, "");
					all.push(t.length > maxLenPerLine ? `${t.slice(0, maxLenPerLine - 1)}…` : t);
				}
			}
		}
		if (all.length <= maxLines) return all;
		return [...all.slice(0, maxLines), `… (+${all.length - maxLines} more lines)`];
	} catch {
		// malformed result — skip
		return [];
	}
}

/** Accumulate thinking deltas; emit one dim line per newline or ~120 chars. */
function appendThinking(child: RpcChild, delta: string): void {
	child.thinkingBuf = (child.thinkingBuf ?? "") + delta;
	for (;;) {
		const nl = child.thinkingBuf.indexOf("\n");
		if (nl !== -1) {
			const piece = child.thinkingBuf.slice(0, nl);
			child.thinkingBuf = child.thinkingBuf.slice(nl + 1);
			const clean = piece.trim();
			if (clean) pushLine(child, `┆ ${clean}`);
			continue;
		}
		if (child.thinkingBuf.length >= THINKING_FLUSH_CHARS) {
			pushLine(child, `┆ ${child.thinkingBuf.slice(0, THINKING_FLUSH_CHARS).trim()}`);
			child.thinkingBuf = child.thinkingBuf.slice(THINKING_FLUSH_CHARS);
			continue;
		}
		break;
	}
}

/** Emit any buffered thinking text as a final dim line. */
function flushThinking(child: RpcChild): void {
	const remaining = (child.thinkingBuf ?? "").trim();
	if (remaining) pushLine(child, `┆ ${remaining}`);
	child.thinkingBuf = "";
}

const MAX_LINE_LENGTH = 200;
const MAX_FULL_LINE_LENGTH = 4000;
const MAX_FULL_BUFFER_LINES = 4000;
const RESULT_MAX_LINES = 60;

function capLine(line: string, cap: number): string {
	return line.length > cap ? `${line.slice(0, cap - 1)}…` : line;
}

/** Push to the short summary buffer only. */
function pushShort(child: RpcChild, line: string): void {
	const clean = line.replace(/\s+/g, " ").trim();
	if (!clean) return;
	child.lines.push(capLine(clean, MAX_LINE_LENGTH));
}

/** Push to the full-fidelity buffer only (preserves leading indent for result bodies). */
function pushFull(child: RpcChild, line: string): void {
	const clean = line.replace(/[ \t]+$/gm, "").trimEnd();
	if (!clean.trim()) return;
	child.fullLines.push(capLine(clean, MAX_FULL_LINE_LENGTH));
}

/** Push to both buffers (short is space-collapsed + capped at 200; full capped at 4000). */
function pushLine(child: RpcChild, line: string): void {
	pushShort(child, line);
	pushFull(child, line);
}

/** Streaming-delta merge into one buffer (word content merges into the last line). */
function appendStreamingInto(lines: string[], delta: string, cap: number): void {
	const parts = delta.split("\n");
	for (let i = 0; i < parts.length; i++) {
		if (i > 0) lines.push("\u200b"); // line break marker (zero-width)
		const piece = parts[i];
		if (!piece) continue;
		const last = lines[lines.length - 1];
		if (last !== undefined && !last.endsWith("…")) {
			lines[lines.length - 1] = capLine(last + piece, cap);
		} else {
			lines.push(capLine(piece, cap));
		}
	}
	// Trim consecutive zero-width marker lines produced by blank deltas.
	while (lines.length > 1 && lines[lines.length - 1] === "\u200b" && lines[lines.length - 2] === "\u200b") {
		lines.pop();
	}
}

function appendStreamingText(child: RpcChild, delta: string): void {
	appendStreamingInto(child.lines, delta, MAX_LINE_LENGTH);
	appendStreamingInto(child.fullLines, delta, MAX_FULL_LINE_LENGTH);
}


/**
 * Send an RPC command and wait for its acknowledgement.
 */
export function rpcCommand(child: RpcChild, command: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcChildEvent> {
	return new Promise((resolve, reject) => {
		if (child.exited) {
			reject(new Error("child already exited"));
			return;
		}
		const id = `cmd-${Math.random().toString(36).slice(2, 10)}`;
		const timer = setTimeout(() => {
			waiters.delete(id);
			reject(new Error(`rpc command timeout: ${String(command.type)}`));
		}, timeoutMs);
		waiters.set(id, {
			resolve: (e) => {
				clearTimeout(timer);
				resolve(e);
			},
			reject: (e) => {
				clearTimeout(timer);
				reject(e);
			},
		});
		child.proc.once("exit", () => {
			const w = waiters.get(id);
			if (w) {
				waiters.delete(id);
				clearTimeout(timer);
				w.reject(new Error(`child exited before responding: ${String(command.type)}`));
			}
		});
		rpcWrite(child, { ...command, id });
	});
}

const waiters = new Map<string, { resolve: (e: RpcChildEvent) => void; reject: (e: Error) => void }>();

/** Deliver a queued response to a pending rpcCommand (called from handleChildLine). */
export function dispatchResponse(id: string, event: RpcChildEvent): boolean {
	const w = waiters.get(id);
	if (!w) return false;
	waiters.delete(id);
	w.resolve(event);
	return true;
}

/**
 * Send a message to a running child: `steer` while streaming, `prompt` when
 * idle. Resolves once the command is accepted.
 */
export async function sendMessageToChild(child: RpcChild, message: string): Promise<void> {
	if (child.busy) {
		const res = await rpcCommand(child, { type: "steer", message });
		if (res.success === false) {
			// Steer rejected (e.g. race where the agent settled between flag read
			// and command write) — fall back to a plain prompt.
			await rpcCommand(child, { type: "prompt", message });
		}
		return;
	}
	await rpcCommand(child, { type: "prompt", message });
}

/** Kill a child process (best effort) — used on session_shutdown and aborts. */
export function killChild(child: RpcChild): void {
	if (child.exited) return;
	try {
		child.proc.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	setTimeout(() => {
		if (!child.exited) {
			try {
				child.proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}
	}, 2000);
}
