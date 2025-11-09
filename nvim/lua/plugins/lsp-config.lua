return {
	{
		"williamboman/mason.nvim",
		cmd = "Mason",
		config = function()
			require("mason").setup()
		end,
	},
	{
		"williamboman/mason-lspconfig.nvim",
		event = { "BufReadPre", "BufNewFile" },
		opts = {
			ensure_installed = {
				"bashls",
				"lua_ls",
				"cssls",
				"pylsp",
				"clangd",
				"html",
				"ts_ls",
				"tailwindcss",
				"jsonls",
				"gopls",
			},
			automatic_enable = false,
		},
	},
	{
		"neovim/nvim-lspconfig",
		event = { "BufReadPre", "BufNewFile" },
		config = function()
			local blink = require("blink.cmp")
			local capabilities = blink.get_lsp_capabilities()

			local servers = {
				"bashls",
				"cssls",
				"lua_ls",
				"pylsp",
				"clangd",
				"html",
				"ts_ls",
				"tailwindcss",
				"jsonls",
				"gopls",
			}

			for _, server in ipairs(servers) do
				vim.lsp.config(server, { capabilities = capabilities })
				vim.lsp.enable(server)
			end

			--Keybinds
			vim.keymap.set("n", "K", vim.lsp.buf.hover, {})
			vim.keymap.set("n", "<leader>ca", vim.lsp.buf.code_action, { desc = "Code action" })
			-- Currently these are getting handled by Snacks.picker --
			-- vim.keymap.set("n", "<leader>gD", vim.lsp.buf.declaration, { desc = "Declaration" })
			-- vim.keymap.set("n", "<leader>gd", vim.lsp.buf.definition, { desc = "Definitions" })
			-- vim.keymap.set("n", "<leader>gr", vim.lsp.buf.references, { desc = "References" })
		end,
	},
}
