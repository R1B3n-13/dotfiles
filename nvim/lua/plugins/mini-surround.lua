return {
	"echasnovski/mini.surround",
	version = "*",
	config = function()
		require("mini.surround").setup({
			mappings = {
				add = "<C-s>a",
				delete = "<C-s>d",
				find = "<C-s>f",
				find_left = "<C-s>F",
				highlight = "<C-s>h",
				replace = "<C-s>r",
			},
		})
	end,
}
