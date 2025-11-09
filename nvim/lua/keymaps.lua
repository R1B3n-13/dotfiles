local map = vim.keymap.set
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- Save current file
map("n", "<leader>w", "<cmd>w<cr>", { desc = "Save file", remap = true })

-- ESC pressing jk
map("i", "jk", "<ESC>", { desc = "jk to esc" })

-- Quit Neovim
map("n", "<leader>q", "<cmd>q<cr>", { desc = "Quit Neovim", remap = true })

-- Increment/decrement
map("n", "+", "<C-a>", { desc = "Increment numbers" })
map("n", "-", "<C-x>", { desc = "Decrement numbers" })

-- Select all
map("n", "<C-a>", "gg<S-v>G", { desc = "Select all" })

-- Indenting
map("v", "<", "<gv", { desc = "Indenting" })
map("v", ">", ">gv", { desc = "Indenting" })

-- Diagnostics
map("n", "<leader>d", "<cmd>lua vim.diagnostic.open_float()<CR>", { desc = "Open diagnostic float" })

-- New tab
map("n", "te", "<cmd>tabedit<cr>")

-- Split window
map("n", "<leader>sh", "<cmd>split<cr><C-w>w", { desc = "splits horizontal" })
map("n", "<leader>sv", "<cmd>vsplit<cr><C-w>w", { desc = "Split vertical" })

-- Navigate vim panes better
map("n", "<C-k>", "<C-w>k", { desc = "Navigate up" })
map("n", "<C-j>", "<C-w>j", { desc = "Navigate down" })
map("n", "<C-h>", "<C-w>h", { desc = "Navigate left" })
map("n", "<C-l>", "<C-w>l", { desc = "Navigate right" })

-- Resize window
map("n", "<C-Up>", "<cmd>resize -3<cr>")
map("n", "<C-Down>", "<cmd>resize +3<cr>")
map("n", "<C-Left>", "<cmd>vertical resize -3<cr>")
map("n", "<C-Right>", "<cmd>vertical resize +3<cr>")

-- Copy Current File Path
map("n", "<leader>p", function()
	local path = vim.fn.expand("%:p")
	vim.fn.setreg("+", path)
	vim.notify("Copied file path: " .. path, vim.log.levels.INFO)
end, { desc = "Copy file path" })
