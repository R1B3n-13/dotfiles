local M = {}

-- Theme mapping: Neovim theme -> Kitty theme
M.theme_map = {
	["catppuccin-latte"] = "catppuccin-latte",
	["catppuccin-frappe"] = "catppuccin-frappe",
	["catppuccin-macchiato"] = "catppuccin-macchiato",
	["catppuccin-mocha"] = "catppuccin-mocha",
	["tokyonight-night"] = "tokyonight-night",
	["tokyonight-storm"] = "tokyonight-storm",
	["tokyonight-day"] = "tokyonight-day",
	["tokyonight-moon"] = "tokyonight-moon",
}

-- Theme persistence file
M.theme_file = vim.fn.stdpath("data") .. "/current_theme.txt"

-- Function to update Kitty theme
function M.update_kitty_theme(kitty_theme)
	local kitty_conf = vim.fn.expand("~/.config/kitty/kitty.conf")
	local lines = {}
	local file = io.open(kitty_conf, "r")

	if file then
		for line in file:lines() do
			table.insert(lines, line)
		end
		file:close()

		-- Update the include line
		for i, line in ipairs(lines) do
			if line:match("^include themes/") then
				lines[i] = "include themes/" .. kitty_theme .. ".conf"
				break
			end
		end

		-- Write back
		file = io.open(kitty_conf, "w")
		if file then
			for _, line in ipairs(lines) do
				file:write(line .. "\n")
			end
			file:close()

			-- Reload Kitty config
			vim.fn.system("kill -SIGUSR1 $(pgrep kitty)")
		end
	end
end

-- Function to save theme
function M.save_theme(theme_name)
	local file = io.open(M.theme_file, "w")
	if file then
		file:write(theme_name)
		file:close()
	end
end

-- Function to load saved theme
function M.load_theme()
	local file = io.open(M.theme_file, "r")
	if file then
		local theme = file:read("*all")
		file:close()
		return theme
	end
	return "catppuccin-mocha" -- default theme
end

-- Function to apply theme
function M.apply_theme(theme_name)
	vim.cmd.colorscheme(theme_name)
	local kitty_theme = M.theme_map[theme_name]
	if kitty_theme then
		M.update_kitty_theme(kitty_theme)
	end
	M.save_theme(theme_name)
end

-- Show theme selection menu
function M.show_menu()
	local themes = {
		{ name = "Catppuccin Latte", value = "catppuccin-latte" },
		{ name = "Catppuccin Frappé", value = "catppuccin-frappe" },
		{ name = "Catppuccin Macchiato", value = "catppuccin-macchiato" },
		{ name = "Catppuccin Mocha", value = "catppuccin-mocha" },
		{ name = "Tokyo Night", value = "tokyonight-night" },
		{ name = "Tokyo Night Storm", value = "tokyonight-storm" },
		{ name = "Tokyo Night Day", value = "tokyonight-day" },
		{ name = "Tokyo Night Moon", value = "tokyonight-moon" },
	}

	vim.ui.select(themes, {
		prompt = "Select Theme:",
		format_item = function(item)
			return item.name
		end,
	}, function(choice)
		if choice then
			M.apply_theme(choice.value)
			vim.notify("Applied: " .. choice.name, vim.log.levels.INFO)
		end
	end)
end

-- Setup function to initialize commands and keymaps
function M.setup()
	-- Load and apply saved theme on startup
	local saved_theme = M.load_theme()
	M.apply_theme(saved_theme)

	-- Create user command
	vim.api.nvim_create_user_command("ThemeSelect", function()
		M.show_menu()
	end, {})

	-- Create keybinding
	vim.keymap.set("n", "<leader>tt", function()
		M.show_menu()
	end, { desc = "Select theme" })
end

return M
