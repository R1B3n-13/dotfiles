return {
	"smjonas/inc-rename.nvim",
	config = function()
		require("inc_rename").setup({ cmd_name = "IncRename" })

		--Keybinds
		vim.keymap.set("n", "<leader>ri", ":IncRename ", { desc = "Incremental rename", noremap = true })
	end,
}
