return {
	"kevinhwang91/nvim-ufo",
	dependencies = { "kevinhwang91/promise-async" },
	config = function()
		require("ufo").setup({
			provider_selector = function(_, _, _)
				return { "treesitter", "indent" }
			end,
		})

		-- Options
		-- vim.o.fillchars = "eob: ,fold: ,foldopen:,foldclose:,foldsep: ,foldinner: "
		-- vim.o.foldcolumn = "1"
		vim.o.foldlevel = 99
		vim.o.foldlevelstart = 99
		vim.o.foldenable = true
	end,
}
