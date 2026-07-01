return {
	"nvim-pack/nvim-spectre",
	dependencies = { "nvim-lua/plenary.nvim", "nvim-tree/nvim-web-devicons" },
	keys = {
		{ "<leader>sa", '<cmd>lua require("spectre").toggle()<CR>', desc = "Toggle Spectre" },
		{
			"<leader>sw",
			'<cmd>lua require("spectre").open_visual({select_word=true})<CR>',
			desc = "Search current word",
		},
		{
			"<leader>sw",
			'<esc><cmd>lua require("spectre").open_visual()<CR>',
			mode = "v",
			desc = "Search current word",
		},
		{
			"<leader>sf",
			'<cmd>lua require("spectre").open_file_search({select_word=true})<CR>',
			desc = "Search on current file",
		},
	},
	config = function()
		require("spectre").setup({
			result_padding = " ",
			default = { replace = { cmd = "sed" } },
		})
	end,
}
