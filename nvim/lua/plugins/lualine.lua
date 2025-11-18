return {
	"nvim-lualine/lualine.nvim",
	event = "VeryLazy",
	config = function()
		require("lualine").setup({
			options = {
				theme = "auto",
				component_separators = "",
				section_separators = { left = "", right = "" },
			},
			sections = {
				lualine_a = {
					{ "mode", icon = "", separator = { left = "" }, padding = { left = 1, right = 2 } },
				},
				lualine_c = {
					{ "filename", icon = "", file_status = true, path = 1, padding = { left = 2, right = 2 } },
				},
				lualine_y = {
					{ "progress", icon = "", padding = { left = 1, right = 1 } },
					{ "location", padding = { left = 0, right = 1 } },
				},
				lualine_z = {
					{
						function()
							return os.date("%R")
						end,
						icon = " ",
						separator = { right = "" },
					},
				},
			},
		})
	end,
}
