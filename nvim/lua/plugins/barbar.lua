return {
	"romgrk/barbar.nvim",
	dependencies = { "nvim-tree/nvim-web-devicons" },
	event = { "BufReadPre", "BufNewFile" },
	config = function()
		require("barbar").setup({
			animation = false,
			auto_hide = 0,
			sidebar_filetypes = {
				NvimTree = true,
				["snacks_layout_box"] = { event = "BufWipeout" },
			},
			icons = {
				filetype = {
					custom_icons = false,
				},
				pinned = { button = "", filename = true },
			},
		})

		--Keybinds
		for i = 1, 9 do
			vim.keymap.set(
				"n",
				"<A-" .. i .. ">",
				"<cmd>BufferGoto " .. i .. "<CR>",
				{ desc = "Move to tab no. " .. i }
			)
		end
		vim.keymap.set("n", "<Tab>", "<cmd>BufferNext<CR>", { desc = "Move to next tab" })
		vim.keymap.set("n", "<S-Tab>", "<cmd>BufferPrevious<CR>", { desc = "Move to previous tab" })
		vim.keymap.set("n", "<A-<>", "<cmd>BufferMovePrevious<CR>", { desc = "Reorder to previous" })
		vim.keymap.set("n", "<A->>", "<cmd>BufferMoveNext<CR>", { desc = "Reorder to next" })
		vim.keymap.set("n", "<A-0>", "<cmd>BufferLast<CR>", { desc = "Move to last tab" })
		vim.keymap.set("n", "<leader>x", "<cmd>BufferClose<CR>", { desc = "Close buffer" })
		vim.keymap.set("n", "<A-p>", "<cmd>BufferPin<CR>", { desc = "Pin buffer" })
	end,
}
