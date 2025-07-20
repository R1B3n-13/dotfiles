local map = vim.keymap.set
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- Save current file
map("n", "<leader>w", ":w<cr>", { desc = "Save file", remap = true })

-- ESC pressing jk
map("i", "jk", "<ESC>", { desc = "jk to esc", noremap = true })

-- Quit Neovim
map("n", "<leader>q", ":q<cr>", { desc = "Quit Neovim", remap = true })

-- Increment/decrement
map("n", "+", "<C-a>", { desc = "Increment numbers", noremap = true })
map("n", "-", "<C-x>", { desc = "Decrement numbers", noremap = true })

-- Select all
map("n", "<C-a>", "gg<S-v>G", { desc = "Select all", noremap = true })

-- Indenting
map("v", "<", "<gv", { desc = "Indenting", silent = true, noremap = true })
map("v", ">", ">gv", { desc = "Indenting", silent = true, noremap = true })

-- New tab
map("n", "te", ":tabedit")

-- Split window
map("n", "<leader>sh", ":split<Return><C-w>w", { desc = "splits horizontal", noremap = true })
map("n", "<leader>sv", ":vsplit<Return><C-w>w", { desc = "Split vertical", noremap = true })

-- Navigate vim panes better
map("n", "<C-k>", "<C-w>k", { desc = "Navigate up" })
map("n", "<C-j>", "<C-w>j", { desc = "Navigate down" })
map("n", "<C-h>", "<C-w>h", { desc = "Navigate left" })
map("n", "<C-l>", "<C-w>l", { desc = "Navigate right" })

-- Resize window
map("n", "<C-Up>", ":resize -3<CR>")
map("n", "<C-Down>", ":resize +3<CR>")
map("n", "<C-Left>", ":vertical resize -3<CR>")
map("n", "<C-Right>", ":vertical resize +3<CR>")

-- Barbar
map("n", "<Tab>", ":BufferNext<CR>", { desc = "Move to next tab", noremap = true })
map("n", "<S-Tab>", ":BufferPrevious<CR>", { desc = "Move to previous tab", noremap = true })
map("n", "<A-1>", ":BufferGoto 1<CR>", { desc = "Move to tab no. 1", noremap = true })
map("n", "<A-2>", ":BufferGoto 2<CR>", { desc = "Move to tab no. 2", noremap = true })
map("n", "<A-3>", ":BufferGoto 3<CR>", { desc = "Move to tab no. 3", noremap = true })
map("n", "<A-4>", ":BufferGoto 4<CR>", { desc = "Move to tab no. 4", noremap = true })
map("n", "<A-5>", ":BufferGoto 5<CR>", { desc = "Move to tab no. 5", noremap = true })
map("n", "<A-6>", ":BufferGoto 6<CR>", { desc = "Move to tab no. 6", noremap = true })
map("n", "<A-7>", ":BufferGoto 7<CR>", { desc = "Move to tab no. 7", noremap = true })
map("n", "<A-8>", ":BufferGoto 8<CR>", { desc = "Move to tab no. 8", noremap = true })
map("n", "<A-9>", ":BufferGoto 9<CR>", { desc = "Move to tab no. 9", noremap = true })
map("n", "<A-0>", ":BufferLast<CR>", { desc = "Move to last tab", noremap = true })
map("n", "<leader>x", ":BufferClose<CR>", { desc = "Close buffer", noremap = true })
map("n", "<A-p>", ":BufferPin<CR>", { desc = "Pin buffer", noremap = true })
