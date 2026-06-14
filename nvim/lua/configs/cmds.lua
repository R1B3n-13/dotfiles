vim.api.nvim_create_autocmd("TextYankPost", {
	desc = "Highlight when yanking (copying) text",
	group = vim.api.nvim_create_augroup("kickstart-highlight-yank", { clear = true }),
	callback = function()
		vim.highlight.on_yank()
	end,
})

vim.api.nvim_create_autocmd("ColorScheme", {
	desc = "Set normal float highlight (makes snacks explorer & picker transparent)",
	pattern = "*",
	callback = function()
		vim.api.nvim_set_hl(0, "NormalFloat", { bg = "NONE" })
	end,
})

local og_virt_text
local og_virt_line
vim.api.nvim_create_autocmd({ "CursorMoved", "DiagnosticChanged" }, {
	group = vim.api.nvim_create_augroup("diagnostic_only_virtlines", {}),
	callback = function()
		if og_virt_line == nil then
			og_virt_line = vim.diagnostic.config().virtual_lines
		end

		-- ignore if virtual_lines.current_line is disabled
		if not (og_virt_line and og_virt_line.current_line) then
			if og_virt_text then
				vim.diagnostic.config({ virtual_text = og_virt_text })
				og_virt_text = nil
			end
			return
		end

		if og_virt_text == nil then
			og_virt_text = vim.diagnostic.config().virtual_text
		end

		local lnum = vim.api.nvim_win_get_cursor(0)[1] - 1

		if vim.tbl_isempty(vim.diagnostic.get(0, { lnum = lnum })) then
			vim.diagnostic.config({ virtual_text = og_virt_text })
		else
			vim.diagnostic.config({ virtual_text = false })
		end
	end,
})

vim.api.nvim_create_autocmd("ModeChanged", {
	group = vim.api.nvim_create_augroup("diagnostic_redraw", {}),
	callback = function()
		pcall(vim.diagnostic.show)
	end,
})

vim.api.nvim_create_autocmd("VimLeave", {
	group = vim.api.nvim_create_augroup("RestoreCursorShapeOnExit", { clear = true }),
	pattern = "*",
	command = "set guicursor=a:ver25-blinkon1-blinkoff1-blinkwait1",
})

vim.api.nvim_create_autocmd("BufWinLeave", {
	desc = "Make Neovim remember folds when leaving a buffer",
	pattern = "*.*",
	callback = function()
		vim.cmd("silent! mkview")
	end,
})

vim.api.nvim_create_autocmd("BufWinEnter", {
	desc = "Load remembered folds when entering a buffer",
	pattern = "*.*",
	callback = function()
		vim.cmd("silent! loadview")
	end,
})

vim.api.nvim_create_autocmd({ "BufWinEnter", "BufEnter" }, {
	desc = "Make fold column disappear for snacks dashboard",
	callback = function()
		vim.schedule(function()
			if vim.bo.filetype == "snacks_dashboard" then
				vim.opt_local.foldcolumn = "0"
				vim.opt_local.foldenable = false
			end
		end)
	end,
})
