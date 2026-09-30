#!/usr/bin/env bash
# Install a pi agent setup from this backup onto a new machine.
# Prereqs: pi installed. Steps: run this script, then re-add API keys (auth.json
# is never backed up) via `pi /login` or by editing ~/.pi/agent/auth.json.
# Usage: bash ~/pi-backup/scripts/install.sh
set -euo pipefail

BAK="$(cd "$(dirname "$0")/.." && pwd)/agent"
DST="$HOME/.pi/agent"
mkdir -p "$DST"

cp "$BAK/"*.json "$DST/" 2>/dev/null || true
cp -r "$BAK/extensions" "$DST/extensions"
cp -r "$BAK/pi-blackhole" "$DST/pi-blackhole" 2>/dev/null || true
cp -r "$BAK/agents" "$DST/agents" 2>/dev/null || true
cp -r "$BAK/skills" "$DST/skills" 2>/dev/null || true
cp "$BAK/"*.md "$DST/" 2>/dev/null || true

# Reinstall npm packages (permission system, adapters, providers...).
if [ -f "$BAK/npm/package.json" ]; then
	mkdir -p "$DST/npm"
	cp "$BAK/npm/"package*.json "$DST/npm/"
	(cd "$DST/npm" && npm install)
	# npm's install-scripts policy can skip postinstall — self-heal explicitly.
	(cd "$DST/npm" && node scripts/fixup.js 2>/dev/null) || true
fi

# Reinstall git packages (e.g. ponytail).
while read -r line; do
	url="${line#git: }"
	if [ -n "$url" ]; then
		pi install "$url" || echo "WARN: failed to install $url — install manually"
	fi
done < "$BAK/GIT_PACKAGES.txt"

# pi-agent-browser-native's peers (@earendil-works/pi-ai, pi-tui) must resolve
# from ~/.pi/agent/npm; ESM lookup cannot see pi's bundled copies on its own.
PI_GLOBAL="$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent"
if [ -d "$PI_GLOBAL/node_modules/@earendil-works" ]; then
	mkdir -p "$DST/npm/node_modules/@earendil-works"
	for peer in pi-ai pi-tui; do
		[ -e "$DST/npm/node_modules/@earendil-works/$peer" ] || \
			ln -s "$PI_GLOBAL/node_modules/@earendil-works/$peer" "$DST/npm/node_modules/@earendil-works/$peer" 2>/dev/null || true
	done
fi

# Browse stack (needs Node >= 24 — the agent-browser CLI hard-requires it).
if command -v node >/dev/null 2>&1; then
	NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
	if [ "$NODE_MAJOR" -ge 24 ]; then
		npm install -g agent-browser@0.38.1 || echo "WARN: agent-browser global install failed"
		mkdir -p "$HOME/.local/bin"
		ln -sf "$(npm root -g)/../bin/agent-browser" "$HOME/.local/bin/agent-browser" 2>/dev/null || true
		command -v agent-browser >/dev/null 2>&1 && agent-browser install || echo "WARN: run 'agent-browser install' to fetch Chromium"
	else
		echo "SKIP browse: node v$NODE_MAJOR < 24. Upgrade node (e.g. nvm install 24), then run:"
		echo "  npm i -g agent-browser@0.38.1 && agent-browser install"
	fi
fi

echo "Restored to $DST"
echo "REMEMBER: auth.json was NOT backed up. Add your API keys (pi /login or edit auth.json)."
