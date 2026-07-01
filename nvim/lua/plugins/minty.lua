return {
	"nvzone/minty",
	dependencies = { "nvzone/volt", lazy = true },
	cmd = { "Shades", "Huefy" },
	keys = {
		{ "<leader>cs", "<cmd>Shades<CR>", desc = "Open color shades" },
		{ "<leader>ch", "<cmd>Huefy<CR>", desc = "Open color hues" },
	},
}
