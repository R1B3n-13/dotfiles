#!/usr/bin/env bash
# Restore a pi agent directory from this backup onto a new machine.
# Prereqs: pi installed. Steps: run this script, then re-add API keys (auth.json
# is never backed up) via `pi /login` or by editing ~/.pi/agent/auth.json.
# Usage: bash ~/pi-backup/scripts/restore.sh
set -euo pipefail

BAK="$(cd "$(dirname "$0")/.." && pwd)/agent"
DST="$HOME/.pi/agent"
mkdir -p "$DST"

cp "$BAK/"*.json "$DST/" 2>/dev/null || true
cp -r "$BAK/extensions" "$DST/extensions"
cp -r "$BAK/pi-blackhole" "$DST/pi-blackhole" 2>/dev/null || true
cp -r "$BAK/agents" "$DST/agents" 2>/dev/null || true
cp -r "$BAK/skills" "$DST/skills" 2>/dev/null || true

# Reinstall npm packages (permission system, adapters, providers...).
if [ -f "$BAK/npm/package.json" ]; then
	mkdir -p "$DST/npm"
	cp "$BAK/npm/"package*.json "$DST/npm/"
	(cd "$DST/npm" && npm install)
fi

# Reinstall git packages (e.g. ponytail).
while read -r line; do
	url="${line#git: }"
	if [ -n "$url" ]; then
		pi install "$url" || echo "WARN: failed to install $url — install manually"
	fi
done < "$BAK/GIT_PACKAGES.txt"

echo "Restored to $DST"
echo "REMEMBER: auth.json was NOT backed up. Add your API keys (pi /login or edit auth.json)."
