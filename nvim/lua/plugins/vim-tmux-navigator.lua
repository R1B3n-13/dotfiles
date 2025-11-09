return {
	"christoomey/vim-tmux-navigator",

	--Keybinds
	vim.keymap.set("n", "C-h", "<Cmd>TmuxNavigateLeft<CR>"),
	vim.keymap.set("n", "C-j", "<Cmd>TmuxNavigateDown<CR>"),
	vim.keymap.set("n", "C-k", "<Cmd>TmuxNavigateUp<CR>"),
	vim.keymap.set("n", "C-l", "<Cmd>TmuxNavigateRight<CR>"),
}
