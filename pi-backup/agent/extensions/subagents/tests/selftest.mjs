#!/usr/bin/env node
// Deterministic selftest for the subagents extension. Run after every pi update:
//   node ~/.pi/agent/extensions/subagents/tests/selftest.mjs         (zero tokens)
//   node ~/.pi/agent/extensions/subagents/tests/selftest.mjs --live  (+1 cheap model call)
// No orchestrator session, no test prompts, no token burn.
import { createJiti } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const PI = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const EXT = "/home/R1B3n/.pi/agent/extensions/subagents";
const TMP = "/tmp/sa-selftest";
let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failures++; console.error(`  ✗ ${m}`); };
const step = (m) => console.log(`\n── ${m}`);

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// ── 1. Static sanity ─────────────────────────────────────────────────────────
step("static sanity (files, frontmatter, env wiring)");
const agentDir = "/home/R1B3n/.pi/agent";
for (const f of ["index.ts", "surface.ts", "session.ts", "activity.ts", "status.ts", "ask-ui.ts"]) {
	existsSync(`${EXT}/${f}`) ? pass(f) : fail(`missing ${f}`);
}
if (existsSync(`${agentDir}/orchestrator-workflow.md`)) pass("orchestrator-workflow.md deployed");
else fail("orchestrator-workflow.md missing");
if (existsSync(`${agentDir}/skills/ask-user/SKILL.md`)) pass("ask-user skill installed");
else fail("ask-user skill missing");
for (const a of ["scout", "worker", "researcher"]) {
	const p = `${agentDir}/agents/${a}.md`;
	if (!existsSync(p)) { fail(`agent ${a}.md missing`); continue; }
	if (/model:\s*openrouter/.test(readFileSync(p, "utf8"))) fail(`${a}.md still has stale openrouter model`);
	else pass(`${a}.md model ok`);
}
const idx = readFileSync(`${EXT}/index.ts`, "utf8");
idx.includes('PI_BLACKHOLE_PASSIVE = "1"') ? pass("children spawn with PI_BLACKHOLE_PASSIVE=1") : fail("PI_BLACKHOLE_PASSIVE missing from spawn env");

// ── 2. TypeScript compile against installed pi (API-breakage detector) ──────
step("tsc against installed pi types");
{
	const r = spawn("npx", ["-y", "-p", "typescript@5.6.3", "tsc", "-p", "/tmp/sa-selftest-tsconfig.json"], { stdio: "pipe" });
	writeFileSync("/tmp/sa-selftest-tsconfig.json", JSON.stringify({
		compilerOptions: {
			target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true,
			noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
			paths: {
				"@earendil-works/pi-coding-agent": [PI + "/dist/index.d.ts"],
				"@earendil-works/pi-tui": [PI + "/node_modules/@earendil-works/pi-tui/dist/index.d.ts"],
				"@sinclair/typebox": [PI + "/node_modules/typebox/build/index.d.mts"],
			},
		},
		include: [EXT + "/**/*.ts"],
	}));
	const ok = await new Promise((res) => {
		const t = setTimeout(() => { r.kill(); res(false); }, 180_000);
		r.on("exit", (code) => { clearTimeout(t); res(code === 0); });
	});
	ok ? pass("tsc clean") : fail("tsc errors — pi API surface changed");
}

// ── 3. Unit suite (renderers, buffers, discovery) ────────────────────────────
step("unit suite (no pi process)");
{
	const r = spawn("node", [`${EXT}/tests/unit.test.mjs`], { stdio: "inherit" });
	const ok = await new Promise((res) => r.on("exit", (c) => res(c === 0)));
	ok ? pass("unit suite green") : fail("unit suite failed");
}

// ── 4. Extension load probe (json mode, NO prompt → zero tokens) ─────────────
step("extension load probe (no model call)");
{
	const probe = `${TMP}/probe-ext.mjs`;
	const out = `${TMP}/probe-out.json`;
	writeFileSync(probe, `export default function (pi) {
	pi.on("session_start", async () => {
		const fs = await import("node:fs");
		fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ tools: (pi.getAllTools?.() ?? []).map((t) => t.name) }));
	});
}\n`);
	const out2 = `${TMP}/probe-out2.json`;
	const proc = spawn("pi", ["--mode", "json", "--session", `${TMP}/load.jsonl`, "-e", probe], { cwd: TMP, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	proc.stderr?.on("data", (c) => (stderr += c));
	const appeared = await new Promise((res) => {
		const t0 = Date.now();
		const iv = setInterval(() => {
			if (existsSync(out)) { clearInterval(iv); res(true); }
			else if (Date.now() - t0 > 45_000) { clearInterval(iv); res(false); }
		}, 250);
	});
	proc.kill();
	if (!appeared) fail(`extension never signalled session_start${stderr ? ` — ${stderr.slice(0, 200)}` : ""}`);
	else {
		const { tools } = JSON.parse(readFileSync(out, "utf8"));
		const need = ["subagent", "subagent_message", "subagents_list", "ask_user"];
		const missing = need.filter((t) => !tools.includes(t));
		missing.length === 0 ? pass(`all 4 tools registered (${tools.length} total)`) : fail(`missing tools: ${missing.join(", ")}`);
		if (existsSync(out2)) rmSync(out2);
	}
}

// ── 5. RPC plumbing probe (child get_state — no model call) ──────────────────
step("rpc child probe (framing + env + get_state, no model call)");
{
	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-coding-agent": PI + "/dist/index.js",
			"@earendil-works/pi-tui": PI + "/node_modules/@earendil-works/pi-tui/dist/index.js",
			"@sinclair/typebox": PI + "/node_modules/typebox/build/index.mjs",
		},
	});
	const surface = await jiti.import(`${EXT}/surface.ts`);
	const { spawnRpcChild, rpcCommand, killChild } = surface;
	const child = spawnRpcChild({
		id: "selftest",
		args: ["--mode", "rpc", "--session", `${TMP}/rpc.jsonl`],
		env: { PI_BLACKHOLE_PASSIVE: "1" },
		cwd: TMP,
		sessionFile: `${TMP}/rpc.jsonl`,
	});
	try {
		const resp = await rpcCommand(child, { type: "get_state" }, 30_000);
		if (resp.success === true) {
			const model = resp.data?.model?.id ?? resp.data?.model;
			pass(`get_state round-trip ok (model: ${typeof model === "string" ? model : JSON.stringify(model)?.slice(0, 40)})`);
		} else fail(`get_state responded success=${resp.success}`);
	} catch (e) {
		fail(`rpc get_state failed: ${String(e).slice(0, 200)}`);
	} finally {
		killChild(child);
	}
}

// ── 6. Optional live check (ONE cheap model call) ─────────────────────────────
if (process.argv.includes("--live")) {
	step("live spawn probe (--live: one scout, one model call)");
	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-coding-agent": PI + "/dist/index.js",
			"@earendil-works/pi-tui": PI + "/node_modules/@earendil-works/pi-tui/dist/index.js",
			"@sinclair/typebox": PI + "/node_modules/typebox/build/index.mjs",
		},
	});
	const surface = await jiti.import(`${EXT}/surface.ts`);
	const { spawnRpcChild, rpcCommand, killChild } = surface;
	const sessionFile = `${TMP}/live.jsonl`;
	const child = spawnRpcChild({
		id: "livetest",
		args: ["--mode", "rpc", "--session", sessionFile, "--model", "inclusionai/ling-3.0-flash-sante:free"],
		env: {
			PI_BLACKHOLE_PASSIVE: "1",
			PI_SUBAGENT_SESSION: sessionFile,
			PI_SUBAGENT_AUTO_EXIT: "1",
			PI_SUBAGENT_NAME: "scout",
			PI_SUBAGENT_AGENT: "scout",
			PI_SUBAGENT_ID: "livetest",
			PI_SUBAGENT_ACTIVITY_FILE: `${TMP}/live-activity.json`,
		},
		cwd: TMP,
		sessionFile,
	});
	try {
		const ack = await rpcCommand(child, { type: "prompt", message: "Run bash: echo live-ok-12345. Then report its output." }, 30_000);
		if (ack.success === false) fail(`prompt rejected: ${String(ack.error ?? "").slice(0, 120)}`);
		const done = await new Promise((res) => {
			const t0 = Date.now();
			const iv = setInterval(() => {
				if (child.exited) { clearInterval(iv); res(true); }
				else if (Date.now() - t0 > 120_000) { clearInterval(iv); res(false); }
			}, 500);
		});
		const session = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : "";
		done && session.includes("live-ok-12345")
			? pass("scout ran bash and reported the marker")
			: fail(done ? "marker missing from child session" : "child did not exit within 120s");
	} catch (e) {
		fail(`live probe failed: ${String(e).slice(0, 200)}`);
	} finally {
		killChild(child);
	}
} else {
	console.log("\n(live probe skipped — pass --live for one cheap model call)");
}

console.log(failures === 0 ? "\nSELFTEST: ALL PASS" : `\nSELFTEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
