return {
	"echasnovski/mini.ai",
	event = { "BufReadPost", "BufNewFile" },
	config = function()
		local config = require("mini.ai")
		config.setup({
			n_lines = 500, -- How far to look for a text object
			custom_textobjects = {
				f = config.gen_spec.treesitter({ a = "@function.outer", i = "@function.inner" }),
				c = config.gen_spec.treesitter({ a = "@class.outer", i = "@class.inner" }),
			},
		})
	end,
}
