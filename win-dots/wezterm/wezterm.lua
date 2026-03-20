local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- Default shell
if wezterm.target_triple:find("windows") then
  config.default_prog = { 'pwsh.exe', '-NoLogo' }
end

-- Colorscheme
config.color_scheme = 'Rosé Pine (Gogh)'

-- Cursor
config.default_cursor_style = "BlinkingBar"
config.cursor_blink_rate = 500  -- in ms

-- Tabs
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = true
config.tab_max_width = 24

-- Custom tab colors
config.colors = {
  tab_bar = {
    background = '#1a1b26',
    active_tab = {
      bg_color = '#16161e',
      fg_color = '#c0caf5',
    },
    inactive_tab = {
      bg_color = '#2a2b3d',
      fg_color = '#a9b1d6',
    },
    inactive_tab_hover = {
      bg_color = '#3b3d5c',
      fg_color = '#c0caf5',
    },
    new_tab = {
      bg_color = '#1a1b26',
      fg_color = '#a9b1d6',
    },
  },
}

return config
