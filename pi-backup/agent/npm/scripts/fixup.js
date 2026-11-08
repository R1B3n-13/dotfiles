// Self-healing for host-provided peer packages after every npm install.
// pi's extension loader requires host packages (@earendil-works/*) to resolve
// to the host's own copies; installed duplicates are pruned/patched here.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const nm = path.join(__dirname, "..", "node_modules");
// pi may live under the system npm prefix or an nvm one — probe candidates.
const candidates = [];
try { candidates.push(execSync("npm root -g").toString().trim()); } catch {}
candidates.push("/usr/lib/node_modules");
const host = candidates
	.map((r) => path.join(r, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works"))
	.find((d) => fs.existsSync(d)) || "";

// 1. Symlink host peers into our tree (npm prunes symlinks on every sync).
if (fs.existsSync(host)) {
	for (const name of ["pi-ai", "pi-tui"]) {
		const target = path.join(nm, "@earendil-works", name);
		const src = path.join(host, name);
		if (!fs.existsSync(src)) continue;
		try {
			if (fs.lstatSync(target).isSymbolicLink() && fs.readlinkSync(target) === src) continue;
		} catch {} // missing — create below
		fs.rmSync(target, { force: true, recursive: true });
		fs.symlinkSync(src, target, "dir");
	}
}

// 2. Patch third-party extension packages: host-provided packages belong in
// peerDependencies ("*"), not dependencies (pi 0.99+ warns on installed copies).
for (const pkgName of ["pi-lsp-adapter", "pi-smart-fetch"]) {
	const pkgPath = path.join(nm, pkgName, "package.json");
	if (!fs.existsSync(pkgPath)) continue;
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	const HOST = ["@earendil-works/pi-tui", "typebox", "@sinclair/typebox"];
	let changed = false;
	for (const dep of HOST) {
		if (pkg.dependencies?.[dep]) {
			delete pkg.dependencies[dep];
			pkg.peerDependencies = pkg.peerDependencies || {};
			pkg.peerDependencies[dep] = "*";
			changed = true;
		}
	}
	if (changed || Object.keys(pkg.dependencies ?? {}).length === 0) {
		if (pkg.dependencies && Object.keys(pkg.dependencies).length === 0) delete pkg.dependencies;
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
	}
}


// 4. pi-permission-system: session-scoped yolo. The gate runner's only yolo
// reader prefers PI_SESSION_YOLO (set per-session by the subagents extension)
// over the shared config file, so concurrent sessions keep independent gate
// policies. Only the child fallback path (env unset) ever consults the file.
{
	const idxPath = path.join(nm, "@gotgenes", "pi-permission-system", "src", "index.ts");
	try {
		let t = fs.readFileSync(idxPath, "utf8");
		const orig = "const isYoloEnabled = (): boolean => isYoloModeEnabled(configStore.current());";
		const patched = "const isYoloEnabled = (): boolean => { const v = process.env.PI_SESSION_YOLO; return v === \"1\" ? true : v === \"0\" ? false : isYoloModeEnabled(configStore.current()); }; // [subagents-fixup] per-session gate yolo via env";
		if (t.includes(patched)) {
			// already patched
		} else if (t.includes(orig)) {
			t = t.replace(orig, patched);
			fs.writeFileSync(idxPath, t);
		}
	} catch {}
}
// 3. pi-permission-system: silence its own "yolo" footer slot — our mode
// footer already shows the resulting policy (normal.auto etc.), and their
// slot re-renders on every turn prep, duplicating it. Patch is tolerant:
// only applied when the exact code is present.
{
	const statusPath = path.join(nm, "@gotgenes", "pi-permission-system", "src", "config", "status.ts");
	try {
		let t = fs.readFileSync(statusPath, "utf8");
		const orig = "return isYoloModeEnabled(config)\n    ? PERMISSION_SYSTEM_YOLO_STATUS_VALUE\n    : undefined;";
		const patched = "return undefined; // [subagents-fixup] yolo footer slot disabled — mode slot shows the policy";
		if (t.includes(patched)) {
			// already patched
		} else if (t.includes(orig)) {
			t = t.replace(orig, patched);
			fs.writeFileSync(statusPath, t);
		}
	} catch {}
}
