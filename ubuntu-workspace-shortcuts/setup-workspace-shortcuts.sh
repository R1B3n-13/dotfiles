#!/usr/bin/env bash
# setup-workspace-shortcuts.sh
# Sets up Super+1..9 for workspace switching and Super+Shift+1..9 for moving windows
# Disables ALL conflicting keybindings

set -euo pipefail

NUM_WORKSPACES=${1:-8}

echo "Setting fixed workspace count to $NUM_WORKSPACES..."
gsettings set org.gnome.desktop.wm.preferences num-workspaces "$NUM_WORKSPACES"
gsettings set org.gnome.mutter dynamic-workspaces false

echo ""
echo "Disabling conflicting keybindings..."

# Disable Dash-to-Dock hotkeys
echo "  • Disabling Dash-to-Dock Super+number hotkeys..."
gsettings set org.gnome.shell.extensions.dash-to-dock hot-keys false 2>/dev/null || true

# Disable GNOME Shell's switch-to-application-N bindings (Super+1..9 for pinned apps)
echo "  • Disabling GNOME Shell application switcher (Super+1..9)..."
for i in $(seq 1 9); do
    gsettings set org.gnome.shell.keybindings "switch-to-application-$i" "[]" 2>/dev/null || true
done

# Clear any existing workspace bindings
echo "  • Clearing existing workspace bindings..."
for i in $(seq 1 12); do
    gsettings set org.gnome.desktop.wm.keybindings "switch-to-workspace-$i" "[]" 2>/dev/null || true
    gsettings set org.gnome.desktop.wm.keybindings "move-to-workspace-$i" "[]" 2>/dev/null || true
done

echo ""
echo "Setting up workspace shortcuts..."

# Set Super+N to switch to workspace N (for workspaces 1-9)
for i in $(seq 1 9); do
    if [ $i -le "$NUM_WORKSPACES" ]; then
        echo "  Super+$i → Switch to workspace $i"
        gsettings set org.gnome.desktop.wm.keybindings "switch-to-workspace-$i" "['<Super>$i']"

        echo "  Super+Shift+$i → Move window to workspace $i"
        gsettings set org.gnome.desktop.wm.keybindings "move-to-workspace-$i" "['<Super><Shift>$i']"
    fi
done

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✓ Done! Workspace shortcuts configured."
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Configured shortcuts:"
echo "  Super+1..9        → Switch to workspace 1..9"
echo "  Super+Shift+1..9  → Move window to workspace 1..9"
echo ""
echo "Changes take effect immediately. Test with Super+1, Super+2, etc."
echo ""
echo "Note: Super+number will NO LONGER launch pinned applications."
echo "      Use Super+Space to search for apps instead."
echo ""
echo "To restore pinned app shortcuts (Super+1..9):"
echo "  gsettings set org.gnome.shell.extensions.dash-to-dock hot-keys true"
echo "  for i in {1..9}; do gsettings reset org.gnome.shell.keybindings switch-to-application-\$i; done"
echo ""
echo "To completely revert all changes:"
echo "  for i in {1..12}; do gsettings reset org.gnome.desktop.wm.keybindings switch-to-workspace-\$i; done"
echo "  for i in {1..12}; do gsettings reset org.gnome.desktop.wm.keybindings move-to-workspace-\$i; done"
echo "  gsettings reset org.gnome.mutter dynamic-workspaces"
