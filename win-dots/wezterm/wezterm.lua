local wezterm = require 'wezterm'
local config = wezterm.config_builder()

if wezterm.target_triple:find("windows") then
  config.default_prog = { 'pwsh.exe', '-NoLogo' }
  config.color_scheme = 'Rosé Pine (Gogh)'
  config.default_cursor_style = "BlinkingBar"
end

return config