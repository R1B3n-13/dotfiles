return {
	"stevearc/conform.nvim",
	event = { "BufWritePre" },
	cmd = { "ConformInfo" },
	keys = {
		{
			"<leader>cf",
			function()
				require("conform").format({ async = true })
			end,
			mode = "",
			desc = "Format buffer",
		},
	},
	config = function()
		local conform = require("conform")
		conform.setup({
			formatters_by_ft = {
				lua = { "stylua" },
				bash = { "beautysh" },
				sh = { "beautysh" },
				html = { "prettierd" },
				javascript = { "prettierd" },
				typescript = { "prettierd" },
				json = { "prettierd" },
				css = { "prettierd" },
				markdown = { "prettierd" },
				cpp = { "clang-format" },
			},
			default_format_opts = {
				lsp_format = "fallback",
			},
		})
	end,
}
