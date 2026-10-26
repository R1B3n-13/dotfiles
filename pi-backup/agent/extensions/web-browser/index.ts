// browser-web — web_search / web_fetch / batch_web_fetch backed by the
// agent-browser CLI (Chromium-grade read pipeline: HTTP html-fallback first,
// rendered DOM via `browser: true`). Replaces pi-smart-web-search +
// pi-smart-fetch with zero API keys and zero configuration. Requires only the
// agent-browser CLI on PATH.
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";

const BING_SERP = "https://www.bing.com/search?q={q}&setlang=en&cc=US";
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
		async execute(params: { searches: string[] }) {
			const queries = params.searches.slice(0, 6);
			const sections: string[] = [];
			const allLinks: Array<{ title: string; url: string }> = [];
			const failures: string[] = [];
			for (const q of queries) {
				const url = BING_SERP.replace("{q}", encodeURIComponent(q));
				let r = await browserRead(url);
				let results = r.ok ? parseSerpMarkdown(r.content, 10) : [];
				// Junk guard: Bing occasionally serves filler to automated
				// reads. If nothing parsed, retry through the rendered path
				// (real page load) once.
				if (r.ok && results.length < 2) {
					const rr = await renderedReader(url);
					if (rr.ok) {
						r = rr;
						results = parseSerpMarkdown(rr.content, 10);
					}
				}
				if (!r.ok) {
					failures.push(`"${q}": ${r.error}`);
					continue;
				}
				if (results.length === 0) {
					// Page OK but nothing parsed — pass the raw markdown so the
					// model still sees whatever came back.
					sections.push(`## ${q}\n\n${cap(r.content, MAX_PER_QUERY)}`);
					continue;
				}
				for (const item of results) allLinks.push(item);
				const rendered = results
					.map((item) => `- **${item.title}**\n  ${item.url}`)
					.join("\n");
				sections.push(`## ${q}\n\n${cap(rendered, MAX_PER_QUERY)}`);
			}
			if (sections.length === 0) {
				return { content: [{ type: "text", text: `No results. ${failures.join(" | ")}` }], details: { queries, failures, links: 0 } };
			}
			const summary = allLinks.length > 0
				? `## Read these pages\n${allLinks.map((l, i) => `${i + 1}. ${l.url} — open to ${l.title}`).join("\n")}`
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
		async execute(params: { url: string; maxChars?: number; browser?: boolean }) {
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
		async execute(params: { requests: Array<{ url: string; maxChars?: number }> }) {
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
