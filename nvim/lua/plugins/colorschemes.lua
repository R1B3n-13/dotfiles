return {
	{
		"folke/tokyonight.nvim",
		priority = 1000,
		config = function()
			require("tokyonight").setup({
				style = "night",
				transparent = true,
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
					barbar = true,
					flash = true,
					ufo = true,
					treesitter = true,
					blink_cmp = {
						style = "bordered",
					},
					notify = true,
					noice = true,
					which_key = true,
					lsp_trouble = true,
					snacks = {
						enabled = true,
						indent_scope_color = "lavender",
					},
					mason = true,
				},
				custom_highlights = function(colors)
					return {
						SnacksPicker = { nocombine = true },
						SnacksPickerBorder = { nocombine = true },
						NormalFloat = { bg = colors.base },
						FloatBorder = { bg = colors.base },
					}
				end,
			})
			vim.cmd.colorscheme("catppuccin-mocha")
		end,
	},
	{
		"scottmckendry/cyberdream.nvim",
		lazy = false,
		priority = 1000,
		config = function()
			local mocha = require("catppuccin.palettes").get_palette("mocha")
			require("cyberdream").setup({
				variant = "default",
				transparent = false,
				saturation = 1,
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
						bg = mocha.base,
						bg_alt = mocha.mantle,
						bg_highlight = mocha.surface0,
						fg = mocha.text,
						grey = mocha.subtext0,
						blue = mocha.blue,
						green = mocha.green,
						cyan = mocha.sapphire,
						red = mocha.red,
						yellow = mocha.yellow,
						magenta = mocha.pink,
						pink = mocha.pink,
						orange = mocha.peach,
						purple = mocha.mauve,
					},
				},
			})
			-- vim.cmd.colorscheme("cyberdream")
		end,
	},
}
