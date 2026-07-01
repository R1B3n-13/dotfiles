return {
	"smjonas/inc-rename.nvim",
	cmd = "IncRename",
	keys = {
		{
			"<leader>ri",
			":IncRename ",
			desc = "Incremental rename",
			noremap = true,
		},
	},
	config = function()
		require("inc_rename").setup({ cmd_name = "IncRename" })
	end,
}
