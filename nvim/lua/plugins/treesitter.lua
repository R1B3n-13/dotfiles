return {
	"nvim-treesitter/nvim-treesitter",
	event = { "BufReadPre", "BufNewFile" },
	branch = "main",
	build = ":TSUpdate",
	config = function()
		local config = require("nvim-treesitter")
		config.setup({
			auto_install = true,
			highlight = { enable = true },
			indent = { enable = true },
		})
	end,
}
