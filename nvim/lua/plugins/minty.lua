return {
	"nvzone/minty",
	dependencies = { "nvzone/volt", lazy = true },
	cmd = { "Shades", "Huefy" },

	-- Keybinds
	vim.keymap.set("n", "<leader>cs", "<cmd>Shades<CR>", { desc = "Open color shades" }),
	vim.keymap.set("n", "<leader>ch", "<cmd>Huefy<CR>", { desc = "Open color hues" }),
}
