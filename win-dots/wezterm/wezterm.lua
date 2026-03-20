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
config.cursor_blink_rate = 500

-- Tabs
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = true
config.tab_max_width = 24

-- Rosé Pine colors
local BAR_BG    = '#191724'
local ACTIVE_BG = '#9ccfd8'
local ACTIVE_FG = '#191724'
local INACT_BG  = '#26233a'
local INACT_FG  = '#6e6a86'
local HOVER_BG  = '#403d52'
local HOVER_FG  = '#e0def4'

-- Bottom margin
config.window_frame = {
  border_bottom_height = '0.4cell',
  border_bottom_color = BAR_BG,
}

local LEFT_SEP  = wezterm.nerdfonts.ple_left_half_circle_thick
local RIGHT_SEP = wezterm.nerdfonts.ple_right_half_circle_thick

wezterm.on('format-tab-title', function(tab, tabs, panes, config, hover, max_width)
  local bg = INACT_BG
  local fg = INACT_FG

  if tab.is_active then
    bg = ACTIVE_BG
    fg = ACTIVE_FG
  elseif hover then
    bg = HOVER_BG
    fg = HOVER_FG
  end

  local title = tab.active_pane.title
  if tab.tab_title and #tab.tab_title > 0 then
    title = tab.tab_title
  end
  title = wezterm.truncate_right(title, max_width - 2)

return {
    { Background = { Color = BAR_BG } },
    { Foreground = { Color = bg } },
    { Text = ' ' .. LEFT_SEP },
    { Background = { Color = bg } },
    { Foreground = { Color = fg } },
    { Text = ' ' .. title .. ' ' },
    { Background = { Color = BAR_BG } },
    { Foreground = { Color = bg } },
    { Text = RIGHT_SEP .. ' ' },
  }
end)

config.colors = {
  tab_bar = {
    background = BAR_BG,
    active_tab   = { bg_color = ACTIVE_BG, fg_color = ACTIVE_FG },
    inactive_tab = { bg_color = INACT_BG,  fg_color = INACT_FG },
    inactive_tab_hover = { bg_color = HOVER_BG, fg_color = HOVER_FG },
    new_tab = { bg_color = BAR_BG, fg_color = INACT_FG },
  },
}

-- Keybindings
config.keys = {
  -- New tab
  {
    key = 'T',
    mods = 'ALT|SHIFT',
    action = wezterm.action.SpawnTab 'CurrentPaneDomain',
  },

  -- Close current tab
  {
    key = 'Q',
    mods = 'ALT|SHIFT',
    action = wezterm.action.CloseCurrentTab { confirm = false },
  },

  -- Switch to tabs 1–9
  { key = '1', mods = 'CTRL', action = wezterm.action.ActivateTab(0) },
  { key = '2', mods = 'CTRL', action = wezterm.action.ActivateTab(1) },
  { key = '3', mods = 'CTRL', action = wezterm.action.ActivateTab(2) },
  { key = '4', mods = 'CTRL', action = wezterm.action.ActivateTab(3) },
  { key = '5', mods = 'CTRL', action = wezterm.action.ActivateTab(4) },
  { key = '6', mods = 'CTRL', action = wezterm.action.ActivateTab(5) },
  { key = '7', mods = 'CTRL', action = wezterm.action.ActivateTab(6) },
  { key = '8', mods = 'CTRL', action = wezterm.action.ActivateTab(7) },
  { key = '9', mods = 'CTRL', action = wezterm.action.ActivateTab(8) },

-- Move tab left
  {
    key = 'B',
    mods = 'ALT|SHIFT',
    action = wezterm.action.MoveTabRelative(-1),
  },
  -- Move tab right
  {
    key = 'N',
    mods = 'ALT|SHIFT',
    action = wezterm.action.MoveTabRelative(1),
  },
}

return config
