// Session-file JSONL parsing, name registry, loadout snapshots, stats.
// Ported from pi-interactive-subagents/session.ts — claude-session copy
// helpers and unused branch-summary/merge helpers dropped.
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
	type Dirent,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export interface SessionEntry {
	type: string;
	id: string;
	parentId?: string;
	[key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	};
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string): string[] {
	const raw = readFileSync(parentSessionFile, "utf8");
	const lines = raw.split("\n").filter((line) => line.trim());

	let truncateAt = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.type === "message" && entry.message?.role === "user") {
				truncateAt = i;
				break;
			}
		} catch {
			// ignore malformed lines
		}
	}

	return lines.slice(0, truncateAt).filter((line) => {
		try {
			return JSON.parse(line).type !== "session";
		} catch {
			return true;
		}
	});
}

export function seedSubagentSessionFile(params: {
	mode: SeededSubagentSessionMode;
	parentSessionFile: string;
	childSessionFile: string;
	childCwd: string;
}): void {
	const header = {
		type: "session",
		version: 3,
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		cwd: params.childCwd,
		parentSession: params.parentSessionFile,
	};
	const contentLines =
		params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
	const lines = [JSON.stringify(header), ...contentLines];

	mkdirSync(dirname(params.childSessionFile), { recursive: true });
	writeFileSync(params.childSessionFile, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Snapshot of a subagent's resolved spawn configuration, written next to its
 * session file as `<sessionFile>.loadout.json` at spawn time so a later
 * `subagent_message({ name })` resume replays the exact same model, tools,
 * identity and spawn whitelist.
 */
export interface SubagentLoadout {
	agent: string | null;
	/** The `--tools` allowlist string, or null when the spawn was unrestricted. */
	toolAllowlist: string | null;
	model: string | null;
	thinking: string | null;
	systemPromptMode: "append" | "replace" | null;
	identity: string | null;
	spawnable: string[] | null;
	autoExit: boolean;
	cwd: string | null;
	agentDir: string | null;
	/** Session id this child forwards permission asks to (root-parent chain). */
	parentSessionId: string | null;
}

export function loadoutSidecarPath(sessionFile: string): string {
	return `${sessionFile}.loadout.json`;
}

export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
	try {
		writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(loadout), "utf8");
	} catch {
		// Best-effort: a missing snapshot only means resume will refuse.
	}
}

export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
	try {
		const p = loadoutSidecarPath(sessionFile);
		if (!existsSync(p)) return null;
		const parsed = JSON.parse(readFileSync(p, "utf8"));
		if (!parsed || typeof parsed !== "object") return null;
		return parsed as SubagentLoadout;
	} catch {
		return null;
	}
}

// ── Name registry ────────────────────────────────────────────────────────────

export interface NameRegistryEntry {
	sessionFile: string;
	sessionId: string | null;
}

export type NameRegistry = Record<string, NameRegistryEntry>;

export function nameRegistryPath(artifactDir: string): string {
	return join(artifactDir, "subagent-registry.json");
}

export function readNameRegistry(artifactDir: string): NameRegistry {
	try {
		const p = nameRegistryPath(artifactDir);
		if (!existsSync(p)) return {};
		const parsed = JSON.parse(readFileSync(p, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as NameRegistry;
	} catch {
		return {};
	}
}

export function registerName(artifactDir: string, name: string, entry: NameRegistryEntry): void {
	try {
		mkdirSync(artifactDir, { recursive: true });
		const registry = readNameRegistry(artifactDir);
		registry[name] = entry;
		const p = nameRegistryPath(artifactDir);
		const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
		writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
		renameSync(tmp, p);
	} catch {
		// Best-effort.
	}
}

export function resolveNameInRegistry(artifactDir: string, name: string): NameRegistryEntry | null {
	const entry = readNameRegistry(artifactDir)[name];
	return entry && typeof entry.sessionFile === "string" ? entry : null;
}

function readEntries(sessionFile: string): SessionEntry[] {
	const raw = readFileSync(sessionFile, "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as SessionEntry);
}

/** Read only the first line of a file without loading the whole thing. */
function readFirstLine(path: string, maxBytes = 65536): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.allocUnsafe(maxBytes);
		const bytes = readSync(fd, buf, 0, maxBytes, 0);
		if (bytes <= 0) return null;
		const nl = buf.indexOf(0x0a);
		const end = nl === -1 || nl >= bytes ? bytes : nl;
		return buf.toString("utf8", 0, end);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

function readHeaderId(sessionFile: string): string | null {
	const firstLine = readFirstLine(sessionFile)?.trim();
	if (!firstLine) return null;
	try {
		const entry = JSON.parse(firstLine) as { type?: string; id?: string };
		return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
	} catch {
		return null;
	}
}

export function getSessionId(sessionFile: string): string | null {
	return readHeaderId(sessionFile);
}

/** Spawn time from the session filename's timestamp prefix (fallback: mtime).
 * Filenames look like 2026-09-19T15-59-39-500Z_<uuid>.jsonl.
 * Needed because parallel spawns race on the name registry, so registry key
 * order is not spawn order. */
export function sessionSpawnTime(sessionFile: string): number {
	const m = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3})Z_/.exec(basename(sessionFile));
	if (m) {
		const iso = m[1].replace(/^((?:\d{4}-\d{2}-\d{2})T\d{2})-(\d{2})-(\d{2})-(\d{3})$/, "$1:$2:$3.$4");
		const t = Date.parse(`${iso}Z`);
		if (Number.isFinite(t)) return t;
	}
	try {
		return statSync(sessionFile).mtimeMs;
	} catch {
		return 0;
	}
}

// ── Session-id index (id/prefix → file) ──────────────────────────────────────

interface SessionIndex {
	idToFile: Map<string, { path: string; mtime: number }>;
	files: Map<string, number>;
	topSig: string;
}
const sessionIndexCache = new Map<string, SessionIndex>();

function topLevelSignature(root: string): string {
	const parts: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return "";
	}
	for (const e of entries) {
		const full = join(root, e.name);
		if (e.isDirectory()) {
			let m = 0;
			try {
				m = statSync(full).mtimeMs;
			} catch {
				/* ignore */
			}
			parts.push(`d:${e.name}:${m}`);
		} else if (e.isFile() && e.name.endsWith(".jsonl")) {
			parts.push(`f:${e.name}`);
		}
	}
	parts.sort();
	return parts.join("|");
}

function indexDir(dir: string, idx: SessionIndex): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			indexDir(full, idx);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			let mtime = 0;
			try {
				mtime = statSync(full).mtimeMs;
			} catch {
				continue;
			}
			const known = idx.files.get(full);
			if (known !== undefined && known === mtime) continue;
			const id = readHeaderId(full);
			idx.files.set(full, mtime);
			if (!id) continue;
			const prev = idx.idToFile.get(id);
			if (!prev || mtime >= prev.mtime) {
				idx.idToFile.set(id, { path: full, mtime });
			}
		}
	}
}

function getSessionIndex(sessionsRoot: string): SessionIndex {
	let idx = sessionIndexCache.get(sessionsRoot);
	const sig = topLevelSignature(sessionsRoot);
	if (!idx) {
		idx = { idToFile: new Map(), files: new Map(), topSig: sig };
		sessionIndexCache.set(sessionsRoot, idx);
		indexDir(sessionsRoot, idx);
	} else if (idx.topSig !== sig) {
		idx.topSig = sig;
		indexDir(sessionsRoot, idx);
	} else {
		indexDir(sessionsRoot, idx);
	}
	return idx;
}

function lookupSessionIndex(
	idx: { idToFile: Map<string, { path: string; mtime: number }> },
	sessionId: string,
): string | null {
	const exact = idx.idToFile.get(sessionId);
	if (exact && existsSync(exact.path)) return exact.path;

	let best: { path: string; mtime: number } | null = null;
	for (const [id, rec] of idx.idToFile) {
		if (!id.startsWith(sessionId)) continue;
		if (!existsSync(rec.path)) continue;
		if (!best || rec.mtime > best.mtime) best = rec;
	}
	return best ? best.path : null;
}

export function resolveSessionFileById(sessionId: string, sessionsRoot: string): string | null {
	if (!sessionId || !existsSync(sessionsRoot)) return null;
	const idx = getSessionIndex(sessionsRoot);
	return lookupSessionIndex(idx, sessionId);
}

export async function resolveSessionFileByIdAsync(
	sessionId: string,
	sessionsRoot: string,
): Promise<string | null> {
	if (!sessionId || !existsSync(sessionsRoot)) return null;
	await new Promise<void>((r) => setImmediate(r));
	const idx = getSessionIndex(sessionsRoot);
	return lookupSessionIndex(idx, sessionId);
}

// ── Entry access ─────────────────────────────────────────────────────────────

export function countSessionEntryLines(sessionFile: string): number {
	try {
		const raw = readFileSync(sessionFile, "utf8");
		let count = 0;
		for (const line of raw.split("\n")) {
			if (line.trim()) count++;
		}
		return count;
	} catch {
		return 0;
	}
}

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
	const raw = readFileSync(sessionFile, "utf8");
	const lines = raw.split("\n").filter((line) => line.trim());
	return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries. Falls back to
 * `errorMessage` when the last assistant message has `stopReason: "error"`.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry as MessageEntry;
		if (msg.message.role !== "assistant") continue;

		const texts = msg.message.content
			.filter(
				(block) =>
					block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
			)
			.map((block) => block.text as string);

		if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

		const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
		const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
		if (
			stopReason === "error" &&
			typeof errorMessage === "string" &&
			errorMessage.trim() !== ""
		) {
			return `Subagent error: ${errorMessage.trim()}`;
		}
	}
	return null;
}

// ── Stats ────────────────────────────────────────────────────────────────────

export interface SessionStats {
	model: string | null;
	toolCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	contextTokens: number;
	cost: number;
}

export function summarizeSessionStats(sessionFile: string): SessionStats | null {
	let entries: SessionEntry[];
	try {
		entries = readEntries(sessionFile);
	} catch {
		return null;
	}

	const stats: SessionStats = {
		model: null,
		toolCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		contextTokens: 0,
		cost: 0,
	};

	for (const entry of entries) {
		if (entry.type === "model_change") {
			const modelId = (entry as { modelId?: unknown }).modelId;
			if (typeof modelId === "string" && modelId) stats.model = modelId;
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = (entry as MessageEntry).message;
		if (msg.role !== "assistant") continue;

		const model = (msg as { model?: unknown }).model;
		if (typeof model === "string" && model) stats.model = model;

		for (const block of msg.content) {
			if (block.type === "toolCall") stats.toolCount++;
		}

		const usage = (msg as { usage?: Record<string, unknown> }).usage;
		if (usage && typeof usage === "object") {
			const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
			stats.inputTokens += num(usage.input);
			stats.outputTokens += num(usage.output);
			stats.cacheReadTokens += num(usage.cacheRead);
			stats.cacheWriteTokens += num(usage.cacheWrite);
			const total = num(usage.totalTokens);
			if (total > 0) stats.contextTokens = total;
			const cost = usage.cost;
			if (cost && typeof cost === "object") stats.cost += num((cost as Record<string, unknown>).total);
		}
	}

	return stats;
}
