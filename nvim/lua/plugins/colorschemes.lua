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

			-- Initialize theme switcher
			local theme_switcher = require("utils.theme-switcher")
			theme_switcher.setup()
		end,
	},
	{
		"rose-pine/neovim",
		name = "rose-pine",
		priority = 1000,
		config = function()
			require("rose-pine").setup({
				variant = "auto",
				dark_variant = "main",
				styles = {
					transparency = true,
					italic = true,
				},
			})
		end,
	},
}
