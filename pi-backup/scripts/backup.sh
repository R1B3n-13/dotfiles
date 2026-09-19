#!/usr/bin/env bash
# Back up the pi agent directory into ~/pi-backup/agent (git-friendly).
# Excludes: secrets (auth.json), node_modules, sessions/history, runtime logs.
# Git-installed packages (public repos) are listed in GIT_PACKAGES.txt instead
# of being copied — reinstall with `pi install <url>` on restore.
# Usage: bash ~/pi-backup/scripts/backup.sh
set -euo pipefail

SRC="$HOME/.pi/agent"
DST="$HOME/pi-backup/agent"

rm -rf "$DST"
mkdir -p "$DST/npm"

# Configs (no secrets — auth.json is the only secret and is NOT copied).
cp "$SRC/settings.json" "$SRC/mcp.json" "$SRC/caveman.json" "$SRC/models-store.json" "$SRC/commandcode-models.json" "$DST/" 2>/dev/null || true

# Extensions: code + policies, but not permission-system audit logs (runtime state).
cp -r "$SRC/extensions" "$DST/extensions"
rm -rf "$DST/extensions/pi-permission-system/logs" 2>/dev/null || true

# Agents + skills.
cp -r "$SRC/agents" "$DST/agents" 2>/dev/null || true
cp -r "$SRC/skills" "$DST/skills" 2>/dev/null || true

# npm package manifest — enough to reinstall node_modules on restore.
cp "$SRC/npm/package.json" "$DST/npm/" 2>/dev/null || true
cp "$SRC/npm/package-lock.json" "$DST/npm/" 2>/dev/null || true

# Git-installed packages: public repos, reinstall instead of copying.
find "$SRC/git/github.com" -mindepth 2 -maxdepth 2 -type d 2>/dev/null \
	| sed 's|.*/github.com/|git: https://github.com/|' > "$DST/GIT_PACKAGES.txt" || true

echo "Backed up to $DST"
du -sh "$DST"
