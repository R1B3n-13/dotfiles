// browser-web — web_search / web_fetch / batch_web_fetch backed by the
// agent-browser CLI (Chromium-grade read pipeline: HTTP html-fallback first,
// rendered DOM via `browser: true`). Replaces pi-smart-web-search +
// pi-smart-fetch with zero API keys and zero configuration. Requires only the
// agent-browser CLI on PATH.
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";

const BRAVE_SERP = "https://search.brave.com/search?q={q}";
const BING_SERP = "https://www.bing.com/search?q={q}&setlang=en&cc=US";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** Raw SERP fetch via curl (its TLS fingerprint passes Brave's bot checks;
 * node's built-in fetch is fingerprinted and 429s). curl falls back to node
 * fetch if absent or failing. */
async function fetchRawHtml(url: string, timeoutMs = 20_000): Promise<{ ok: boolean; html: string; error?: string; status?: number }> {
	try {
		const { spawn } = await import("node:child_process");
		const html = await new Promise<string>((resolve) => {
			const child = spawn("curl", ["-s", "-L", "-A", UA, "-H", "Accept: text/html", "-H", "Accept-Language: en-US,en;q=0.9", "--max-time", String(Math.ceil(timeoutMs / 1000)), url], { stdio: ["ignore", "pipe", "ignore"] });
			let out = "";
			child.stdout?.on("data", (d) => (out += d));
			child.on("error", () => resolve(""));
			child.on("close", (code) => resolve(code === 0 ? out : ""));
		});
		let ok = html.length > 5_000 && !/^<html>\s*<body>blocked/i.test(html);
		if (ok) return { ok, html, status: 200 };
	} catch { /* fall through */ }
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" }, signal: ctrl.signal, redirect: "follow" });
		clearTimeout(t);
		const html = await res.text();
		return { ok: res.ok, html, status: res.status };
	} catch (e) {
		return { ok: false, html: "", error: String((e as Error).message ?? e) };
	}
}

/** Parse a Brave SERP: `snippet` blocks with data-type="web", result anchors
 * carrying title= and href=, description in generic-snippet. */
export function parseBraveSerp(html: string, limit = 10): Array<{ title: string; url: string; snippet?: string }> {
	const blocks = html.split('<div class="snippet ').slice(1);
	const out: Array<{ title: string; url: string; snippet?: string }> = [];
	const seen = new Set<string>();
	for (const block of blocks) {
		if (out.length >= limit) break;
		if (!/data-type="web"/.test(block.slice(0, 300))) continue;
		const hrefM = /<a\b[^>]*href="(https?:\/\/[^"]+)"/.exec(block);
		if (!hrefM) continue;
		const url = hrefM[1];
		if (/brave\.com|imgs\.search\.brave/i.test(url) || seen.has(url)) continue;
		const titleM = /title="([^"]{3,200})"/.exec(block);
		if (!titleM) continue;
		const snippetM = /<div class="generic-snippet[^"]*">([\s\S]{0,600}?)<\/div>/.exec(block);
		const snippet = snippetM ? snippetM[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined;
		seen.add(url);
		out.push({ title: titleM[1], url, snippet });
	}
	return out;
}

const MAX_PER_QUERY = 3500; // chars of markdown kept per search query
const MAX_FETCH = 30_000; // default cap for a single page read
const READ_TIMEOUT_MS = 45_000;
const JS_PAGE_HINT = "(page rendered an empty document — it may require JavaScript; retry with browser: true)";

type ReadResult = { ok: boolean; content: string; error?: string; finalUrl?: string; source?: string };

/** Run `agent-browser read <url> --json` and return its structured content. */
function browserRead(url: string, timeoutMs = READ_TIMEOUT_MS): Promise<ReadResult> {
	return new Promise((resolve) => {
		const child = spawn("agent-browser", ["read", url, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			timer = null;
			child.kill();
			settle({ ok: false, content: "", error: `timed out after ${timeoutMs}ms` });
		}, timeoutMs);
		const settle = (r: ReadResult) => {
			if (settled) return;
			settled = true;
			if (timer) { clearTimeout(timer); timer = null; }
			resolve(r);
		};
		child.stdout?.on("data", (d) => (out += d));
		child.stderr?.on("data", (d) => (err += d));
		child.on("error", (e) => settle({ ok: false, content: "", error: `agent-browser failed: ${String(e.message ?? e)}` }));
		child.on("close", (code) => {
			if (settled) return;
			try {
				const parsed = JSON.parse(out) as { success?: boolean; error?: string; data?: { content?: string; finalUrl?: string; source?: string; error?: string } };
				const data = parsed?.data ?? {};
				if (parsed?.success && typeof data.content === "string") {
					settle({ ok: true, content: data.content, finalUrl: data.finalUrl, source: data.source });
				} else {
					settle({ ok: false, content: "", error: String(parsed?.error ?? data.error ?? `exit ${code}${err ? `: ${err.slice(0, 200)}` : ""}`) });
				}
			} catch {
				settle({ ok: false, content: "", error: `unparseable output (exit ${code})${err ? `: ${err.slice(0, 200)}` : ""}` });
			}
		});
	});
}

function runCli(args: string[], timeoutMs = READ_TIMEOUT_MS): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve) => {
		const child = spawn("agent-browser", args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			timer = null;
			child.kill();
		}, timeoutMs);
		child.stdout?.on("data", (d) => (out += d));
		child.stderr?.on("data", (d) => (err += d));
		child.on("error", () => { if (timer) { clearTimeout(timer); } resolve({ code: -1, out, err: "spawn failed" }); });
		child.on("close", (code) => { if (timer) { clearTimeout(timer); } resolve({ code, out, err }); });
	});
}

/** Rendered-DOM read for JS-heavy pages: open in the managed browser, then
 * read with no URL (reads the rendered active tab). */
async function renderedReader(url: string): Promise<ReadResult> {
	const open = await runCli(["open", url]);
	if (open.code !== 0) return { ok: false, content: "", error: `open failed: ${open.err.slice(0, 200) || `exit ${open.code}`}` };
	const read = await runCli(["read", "--json"]);
	try {
		const parsed = JSON.parse(read.out) as { success?: boolean; error?: string; data?: { content?: string; finalUrl?: string; source?: string; error?: string } };
		const data = parsed?.data ?? {} as { content?: string; finalUrl?: string; source?: string; error?: string };
		if (parsed?.success && typeof data.content === "string") {
			return { ok: true, content: data.content, finalUrl: data.finalUrl, source: "browser-rendered" };
		}
		return { ok: false, content: "", error: String(parsed?.error ?? data.error ?? `read exit ${read.code}`) };
	} catch {
		return { ok: false, content: "", error: `unparseable read output (exit ${read.code})` };
	}
}

function renderBody(r: ReadResult): string {
	if (!r.ok) return `Error: ${r.error}`;
	return r.content.length > 0 ? r.content : JS_PAGE_HINT;
}


/** Parse a Bing SERP as delivered by the read pipeline: result blocks are
 * `https://...` (bare URL line), then `## Title`, then snippet lines, with
 * `-` separators. Skips Bing's own chrome links. */
export function parseSerpMarkdown(markdown: string, limit = 10): Array<{ title: string; url: string }> {
	const lines = markdown.split("\n");
	const out: Array<{ title: string; url: string }> = [];
	let lastUrl = "";
	for (let i = 0; i < lines.length && out.length < limit; i++) {
		const line = lines[i].trim();
		if (/^https?:\/\/\S+$/.test(line)) {
			lastUrl = line;
			continue;
		}
		if (line.startsWith("## ") && lastUrl) {
			const title = line.slice(3).trim();
			if (title && !/bing\.com/i.test(lastUrl)) out.push({ title, url: lastUrl });
			lastUrl = "";
		}
	}
	return out;
}

/** Extract `(title)[url]` links from markdown, deduped, for the search summary. */
function extractLinks(markdown: string, limit = 12): Array<{ title: string; url: string }> {
	const seen = new Set<string>();
	const out: Array<{ title: string; url: string }> = [];
	const re = /\[([^\]\n]{1,120})\]\((https?:\/\/[^)\s]+)[^)]*\)/g;
	for (let m = re.exec(markdown); m !== null && out.length < limit; m = re.exec(markdown)) {
		const url = m[2];
		if (seen.has(url)) continue;
		seen.add(url);
		out.push({ title: m[1].trim(), url });
	}
	return out;
}

const cap = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);

export default function (pi: any) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return each query's results as readable markdown — title, URL and snippet per result — followed by a summary of every result link, to open with web_fetch (a single page) or batch_web_fetch (two or three). Bing-backed via the agent-browser read pipeline; no API key.",
		promptSnippet: "Search the web for current or external information.",
		parameters: Type.Object({
			searches: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 6,
				description:
					"One to six search queries, each fetched as its own results page. Match the count to the question: 1 for a narrow factual lookup, more only when the extra angles would change the answer.",
			}),
		}),
		async execute(_toolCallId: string, params: { searches: string[] }) {
			const queries = params.searches.slice(0, 6);
			const sections: string[] = [];
			const allLinks: Array<{ title: string; url: string }> = [];
			const failures: string[] = [];
			for (const q of queries) {
				// Leg 1: Brave via raw HTTP (automation-tolerant, real results).
				let results: Array<{ title: string; url: string; snippet?: string }> = [];
				let raw = await fetchRawHtml(BRAVE_SERP.replace("{q}", encodeURIComponent(q)));
				let engine = "brave";
				if (raw.ok) results = parseBraveSerp(raw.html, 10);
				// Leg 2: Bing through the agent-browser read pipeline.
				if (results.length < 2) {
					const bingUrl = BING_SERP.replace("{q}", encodeURIComponent(q));
					const r = await browserRead(bingUrl);
					if (r.ok) {
						const alt = parseSerpMarkdown(r.content, 10);
						if (alt.length >= results.length) { results = alt; engine = "bing"; }
					}
				}
				// Leg 3: Bing rendered in the managed browser (junk-rescue).
				const bingUrl = BING_SERP.replace("{q}", encodeURIComponent(q));
				if (results.length < 2) {
					const rr = await renderedReader(bingUrl);
					if (rr.ok) {
						const alt = parseSerpMarkdown(rr.content, 10);
						if (alt.length > results.length) { results = alt; engine = "bing-rendered"; }
					}
				}
				if (results.length === 0) {
					failures.push(`"${q}": all engines failed${raw.error ? ` (brave: ${raw.error})` : ""}`);
					continue;
				}
				const body = results
					.map((item, i) => `- **${cap(item.title, 120)}**\n  ${item.url}${item.snippet ? `\n  ${cap(item.snippet, 220)}` : ""}`)
					.join("\n");
				sections.push(`## ${q} (${engine})\n\n${cap(body, MAX_PER_QUERY)}`);
				for (const item of results) allLinks.push(item);
			}
			if (sections.length === 0) {
				return {
					content: [{ type: "text", text: `No results. ${failures.join(" | ") || "the engines parsed nothing"}. Retry with narrower, entity-explicit queries or use web_fetch directly.` }],
					details: { queries, failures, links: 0 },
				};
			}
			const summary = allLinks.length > 0
				? `## Read these pages\n${allLinks.map((l, i) => `${i + 1}. ${l.url} — open to ${cap(l.title, 80)}`).join("\n")}`
				: `## Read these pages\n(No result links could be parsed this round.)`;
			const parts = [...sections, summary];
			if (failures.length > 0) parts.push(`⚠ partial failures: ${failures.join(" | ")}`);
			return { content: [{ type: "text", text: parts.join("\n\n") }], details: { queries, failures, links: allLinks.length } };
		},
		renderResult(result: any, _o: any, theme: any) {
			const d = result?.details ?? {};
			const head = d.queries
				? `${d.links} links across ${d.queries.length} quer${d.queries.length === 1 ? "y" : "ies"}${d.failures?.length ? ` · ${d.failures.length} failed` : ""}`
				: "no results";
			return new Text(theme.fg("dim", `web_search: ${head}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL through the agent-browser read pipeline (Chromium-grade TLS, readable extraction). Set browser:true for JS-rendered pages — a real Chromium page loads first and the rendered DOM is read.",
		promptSnippet: "Fetch a URL and return readable content.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (http/https only)" }),
			maxChars: Type.Optional(Type.Number({ description: "Maximum characters to return. Default: 30000" })),
			browser: Type.Optional(Type.Boolean({ description: "true: render in a real Chromium page first, then read the rendered DOM — for JavaScript-heavy pages." })),
		}),
		async execute(_toolCallId: string, params: { url: string; maxChars?: number; browser?: boolean }) {
			const r = params.browser === true ? await renderedReader(params.url) : await browserRead(params.url);
			const text = cap(renderBody(r), params.maxChars ?? MAX_FETCH);
			return {
				content: [{ type: "text", text }],
				details: r.ok ? { finalUrl: r.finalUrl, source: r.source, chars: text.length } : { failed: true },
			};
		},
		renderResult(result: any, _o: any, theme: any) {
			const d = result?.details ?? {};
			const head = d.failed ? "failed" : `${d.chars ?? "?"} chars · ${d.source ?? ""}`;
			return new Text(theme.fg("dim", `web_fetch: ${head}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "batch_web_fetch",
		label: "Batch Web Fetch",
		description:
			"Fetch multiple URLs through the agent-browser read pipeline. Each request accepts url and maxChars. Two to three per batch — heavier on tokens than web_fetch, so keep batches small.",
		promptSnippet: "Fetch multiple URLs concurrently.",
		parameters: Type.Object({
			requests: Type.Array(Type.Object({ url: Type.String(), maxChars: Type.Optional(Type.Number()) }), { minItems: 1, maxItems: 3 }),
		}),
		async execute(_toolCallId: string, params: { requests: Array<{ url: string; maxChars?: number }> }) {
			const reqs = params.requests.slice(0, 3);
			const results = await Promise.allSettled(reqs.map((req) => browserRead(req.url)));
			let failed = 0;
			const body = results.map((res, i) => {
				const url = reqs[i].url;
				if (res.status !== "fulfilled") {
					failed++;
					return `=== [${i + 1}] ${url} — status failed ===\nError: ${String((res as PromiseRejectedResult).reason).slice(0, 200)}`;
				}
				if (!res.value.ok) {
					failed++;
					return `=== [${i + 1}] ${url} — status failed ===\nError: ${res.value.error}`;
				}
				const max = reqs[i].maxChars ?? 12_000;
				return `=== [${i + 1}] ${url} — status ok ===\n${cap(res.value.content, max)}`;
			});
			return { content: [{ type: "text", text: body.join("\n\n") }], details: { count: reqs.length, failed } };
		},
	});
}
