return {
	"echasnovski/mini.ai",
	event = { "BufReadPost", "BufNewFile" },
	config = function()
		local ai = require("mini.ai")
		local ts = ai.gen_spec.treesitter
		ai.setup({
			n_lines = 500,
			custom_textobjects = {
				f = ts({ a = "@function.outer", i = "@function.inner" }),
				c = ts({ a = "@class.outer", i = "@class.inner" }),
				i = ts({ a = "@conditional.outer", i = "@conditional.inner" }),
				l = ts({ a = "@loop.outer", i = "@loop.inner" }),
				p = ts({ a = "@parameter.outer", i = "@parameter.inner" }),
				k = ts({ a = "@call.outer", i = "@call.inner" }),
				b = ts({ a = "@block.outer", i = "@block.inner" }),
				r = ts({ a = "@return.outer", i = "@return.inner" }),
				["="] = ts({ a = "@assignment.outer", i = "@assignment.rhs" }),
				["/"] = ts({ a = "@comment.outer", i = "@comment.inner" }),
			},
		})
	end,
}
