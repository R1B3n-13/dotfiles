-- Enable the experimental 0.12 UI layer
pcall(function()
	require("vim._core.ui2").enable()
end)

-- Load modular configurations
require("configs.options")
require("configs.keymaps")
require("configs.cmds")

-- Bootstrap Lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) then
	vim.fn.system({
		"git",
		"clone",
		"--filter=blob:none",
		"https://github.com/folke/lazy.nvim.git",
		"--branch=stable",
		lazypath,
	})
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
	spec = {
		{ import = "plugins" },
	},
	defaults = {
		lazy = false,
	},
})

-- Global diagnostic overrides
vim.diagnostic.config({
	virtual_text = true,
	virtual_lines = { current_line = true },
	underline = true,
	severity_sort = true,
	update_in_insert = false,
})
