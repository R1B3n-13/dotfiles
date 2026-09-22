// Unit suite for the subagents extension — no pi process, no LLM, no tokens.
// Run directly: node unit.test.mjs   (or via selftest.mjs)
import { createJiti } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const PI = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": PI + "/dist/index.js",
		"@earendil-works/pi-tui": PI + "/node_modules/@earendil-works/pi-tui/dist/index.js",
		"@sinclair/typebox": PI + "/node_modules/typebox/build/index.mjs",
	},
});
const mod = await jiti.import("/home/R1B3n/.pi/agent/extensions/subagents/index.ts");
const { renderRibbonLines, collectDescendantEntries } = mod;
const surface = await jiti.import("/home/R1B3n/.pi/agent/extensions/subagents/surface.ts");
const { trackDisplayState, summarizeToolArgs, summarizeToolResultLines } = surface;

let failures = 0;
const assert = (c, m) => { if (!c) { failures++; console.error("FAIL:", m); } };
const strip = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");
const now = Date.now();

// ── 2-up render
const base2 = [
	{ name: "w1", agent: "worker", startTime: now - 62_000, statusText: "active read", lines: ["→ bash: sleep 30", "┆ thinking", "← bash: done"] },
	{ name: "w2", agent: "worker", startTime: now - 61_000, statusText: "running 1m", lines: [] },
];
const r1 = renderRibbonLines(base2, 100, { contentLines: 6 }).map(strip);
assert(r1.some((l) => l.includes("w1 (worker)")), "2-up renders boxes");
assert(r1.some((l) => l.includes("Alt+E zoom")), "zoom hint present");

// ── focus: borders + window-follow
const ACCENT = "\x1b[38;2;77;163;255m";
const DIMC = "\x1b[90m";
const three = ["a", "b", "c"].map((n) => ({ name: n, agent: "worker", startTime: now, statusText: "active", lines: [] }));
const rf = renderRibbonLines(three, 100, { contentLines: 3, focus: 1 });
const topLine = rf.find((l) => l.includes("╭"));
assert(topLine.includes(ACCENT) && topLine.includes(DIMC), "border row mixes focused accent + neighbor dim");
assert(rf.map(strip).some((l) => l.includes("focus: b")), "footer names focused pane");
const rf2 = renderRibbonLines(three, 100, { contentLines: 3, focus: 2 }).map(strip);
assert(rf2.some((l) => l.includes("b (worker)")) && rf2.some((l) => l.includes("c (worker)")), "viewport follows focus");

// ── per-pane edge colors (focused accent, neighbor dim — position aware)
const rf3 = renderRibbonLines(three, 100, { contentLines: 3, focus: 1 });
const row0 = rf3.filter((l) => l.includes("│"))[0];
const firstAccent = row0.indexOf(ACCENT);
const lastDim = row0.lastIndexOf(DIMC);
assert(firstAccent !== -1 && lastDim !== -1 && firstAccent < lastDim, "focused rails accent before neighbor dim rails");
const rf4 = renderRibbonLines(three, 100, { contentLines: 3, focus: 2 });
const row1 = rf4.filter((l) => l.includes("│"))[0];
const left2 = row1.slice(0, row1.indexOf(ACCENT) === -1 ? row1.length : row1.indexOf(ACCENT));
assert(left2.includes(DIMC), "neighbor edges dim when focused pane is right");

// ── zoom: full-fidelity wrapped content
const zoomEntry = {
	name: "z", agent: "worker", startTime: now, statusText: "active",
	lines: [`→ bash: ${"x".repeat(150)}…`],
	fullLines: [`→ bash: bash -c '${"x".repeat(250)}'`, "← bash: done 1", "  detail line 2", "  detail line 3"],
};
const rz = renderRibbonLines([zoomEntry], 100, { contentLines: 4, zoom: true, focus: 0 }).map(strip);
const joined = rz.join("\n");
assert(joined.includes("x".repeat(80)), "zoom shows untruncated wrapped args");
assert(joined.includes("  detail line 2") && joined.includes("  detail line 3"), "result bodies indented in zoom");

// ── dual buffers via trackDisplayState
const child = { lines: [], fullLines: [], busy: false, exited: false, exitCode: null, lastError: null, id: "t", proc: null, sessionFile: "/x" };
const ev = (type, extra = {}) => ({ type, ...extra });
trackDisplayState(child, ev("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "pondering the " } }));
trackDisplayState(child, ev("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "universe" } }));
trackDisplayState(child, ev("message_update", { assistantMessageEvent: { type: "text_delta", delta: "Answer: " } }));
trackDisplayState(child, ev("message_update", { assistantMessageEvent: { type: "toolcall_start", toolName: "bash" } }));
trackDisplayState(child, ev("tool_execution_start", { toolName: "bash", args: { command: "sleep 30 && echo hi" } }));
trackDisplayState(child, ev("tool_execution_end", { toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hi\nline2\nline3" }] } }));
trackDisplayState(child, ev("agent_end"));
assert(child.lines.some((l) => l.includes("→ bash: sleep 30 && echo hi")), "short tool line");
assert(child.fullLines.some((l) => l.includes("← bash: hi")), "full result line");
assert(child.fullLines.some((l) => l.trim() === "line2") && !child.lines.some((l) => l.includes("line2")), "result bodies full-only");
const tf = child.fullLines.filter((l) => l.startsWith("┆"));
assert(tf.length === 1 && tf[0].includes("pondering the universe"), "thinking merged into one full line");

// ── thinking merge across chunks, newline breaks thought
const c2 = { lines: [], fullLines: [], busy: false, exited: false, exitCode: null, lastError: null, id: "t", proc: null, sessionFile: "/x" };
trackDisplayState(c2, ev("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "First sentence. " } }));
trackDisplayState(c2, ev("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "Second continues. " } }));
trackDisplayState(c2, ev("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "Third ends.\n" } }));
assert(c2.fullLines.filter((l) => l.startsWith("┆")).length === 1, "one thought line before newline");
trackDisplayState(c2, ev("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "New thought." } }));
trackDisplayState(c2, ev("agent_end"));
assert(c2.fullLines.filter((l) => l.startsWith("┆")).length === 2, "newline starts new thought line");

// ── arg/result summaries
assert(summarizeToolArgs("bash", { command: "sleep 30 && echo hi" }, 60) === "sleep 30 && echo hi", "bash arg summary");
assert(summarizeToolArgs("batch_web_fetch", { requests: [{ url: "https://x.dev/a" }] }, 60).includes("x.dev"), "generic fallback summary");
assert(summarizeToolResultLines({ content: [{ type: "text", text: "a\nb\nc" }] }, 2).length === 3, "result line cap adds ellipsis marker");

// ── descendant discovery regression
const dBase = "/tmp/sa-selftest-tree/sess";
mkdirSync(`${dBase}/artifacts/w1/subagent-activity`, { recursive: true });
const scoutFile = `${dBase}/2026-09-19T00-00-00-000Z_scoutid-abc.jsonl`;
writeFileSync(scoutFile, JSON.stringify({ type: "session", version: 3, id: "g1" }) + "\n");
writeFileSync(`${dBase}/artifacts/w1/subagent-registry.json`, JSON.stringify({ scout1: { sessionFile: scoutFile, sessionId: "g1" } }));
writeFileSync(`${dBase}/artifacts/w1/subagent-activity/scoutid.json`, JSON.stringify({ version: 1, phase: "active", latestEvent: "tool_call", toolName: "ls", activeScope: "tool", createdAt: now - 30_000, updatedAt: now, sequence: 5 }));
writeFileSync("/tmp/sa-selftest-tree/sess/worker.jsonl", JSON.stringify({ type: "session", version: 3, id: "w1" }) + "\n");
const found = collectDescendantEntries(`${dBase}/artifacts/w1`, 0);
assert(found.length === 1 && found[0].name === "scout1", "descendant discovery");

console.log(failures === 0 ? `unit: all ${21} checks passed` : `unit: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
