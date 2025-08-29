return {
	{
		"folke/tokyonight.nvim",
		priority = 1000,
		config = function()
			require("tokyonight").setup({
				style = "night",
				transparent = false,
				terminal_colors = true,
				styles = {
					sidebars = "dark",
					floats = "dark",
					comments = { italic = true },
					keywords = { italic = true },
				},
			})
			-- vim.cmd.colorscheme("tokyonight-night")
		end,
	},
	{
		"catppuccin/nvim",
		name = "catppuccin",
		priority = 1000,
		config = function()
			require("catppuccin").setup({
				flavor = "mocha",
				transparent_background = false,
				term_colors = true,
				styles = {
					comments = { "italic" },
					keywords = { "italic" },
					types = { "italic" },
					conditionals = {},
				},
				integrations = {
					treesitter = true,
					notify = true,
					noice = true,
					which_key = true,
					lsp_trouble = true,
					snacks = {
						enabled = true,
					},
					mason = true,
				},
			})
			-- vim.cmd.colorscheme("catppuccin-mocha")
		end,
	},
	{
		"scottmckendry/cyberdream.nvim",
		lazy = false,
		priority = 1000,
		config = function()
			require("cyberdream").setup({
				variant = "default",
				transparent = false,
				saturation = 0.95,
				italic_comments = true,
				borderless_pickers = false,
				terminal_colors = true,
				extensions = {
					blinkcmp = true,
					lazy = true,
					noice = true,
					notify = true,
					snacks = true,
					treesitter = true,
					treesittercontext = true,
					trouble = true,
					whichkey = true,
				},
				colors = {
					dark = {
						bg_highlight = "#2a2d33",
					},
				},
			})
			vim.cmd.colorscheme("cyberdream")
		end,
	},
}
