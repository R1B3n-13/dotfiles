return {
	"nvim-treesitter/nvim-treesitter-textobjects",
	dependencies = { "nvim-treesitter/nvim-treesitter" },
	config = function()
		require("nvim-treesitter.configs").setup({
			textobjects = {
				select = {
					enable = true,
					lookahead = true,
					keymaps = {
						["af"] = { query = "@function.outer", desc = "Select around function" },
						["if"] = { query = "@function.inner", desc = "Select inside function" },
						["ac"] = { query = "@class.outer", desc = "Select around class" },
						["ic"] = { query = "@class.inner", desc = "Select inside class" },
						["as"] = { query = "@local.scope", query_group = "locals", desc = "Select local scope" },
					},
					selection_modes = {
						["@parameter.outer"] = "v",
						["@function.outer"] = "V",
						["@class.outer"] = "V",
					},
					include_surrounding_whitespace = false,
				},
				swap = {
					enable = true,
					swap_next = {
						["<leader>a"] = { query = "@parameter.inner", desc = "Swap parameter with next" },
					},
					swap_previous = {
						["<leader>A"] = { query = "@parameter.inner", desc = "Swap parameter with previous" },
					},
				},
				move = {
					enable = true,
					set_jumps = true,
					goto_next_start = {
						["]f"] = { query = "@function.outer", desc = "Next function start" },
						["]c"] = { query = "@class.outer", desc = "Next class start" },
						["]o"] = { query = { "@loop.inner", "@loop.outer" }, desc = "Next loop start" },
						["]s"] = { query = "@local.scope", query_group = "locals", desc = "Next scope" },
						["]z"] = { query = "@fold", query_group = "folds", desc = "Next fold" },
					},
					goto_next_end = {
						["]F"] = { query = "@function.outer", desc = "Next function end" },
						["]C"] = { query = "@class.outer", desc = "Next class end" },
					},
					goto_previous_start = {
						["[f"] = { query = "@function.outer", desc = "Previous function start" },
						["[c"] = { query = "@class.outer", desc = "Previous class start" },
						["[o"] = { query = { "@loop.inner", "@loop.outer" }, desc = "Previous loop start" },
						["[s"] = { query = "@local.scope", query_group = "locals", desc = "Previous scope" },
						["[z"] = { query = "@fold", query_group = "folds", desc = "Previous fold" },
					},
					goto_previous_end = {
						["[F"] = { query = "@function.outer", desc = "Previous function end" },
						["[C"] = { query = "@class.outer", desc = "Previous class end" },
					},
					goto_next = {
						["]d"] = { query = "@conditional.outer", desc = "Next conditional" },
					},
					goto_previous = {
						["[d"] = { query = "@conditional.outer", desc = "Previous conditional" },
					},
				},
			},
		})

		-- Setup repeatable movements
		local ts_repeat_move = require("nvim-treesitter.textobjects.repeatable_move")

		vim.keymap.set({ "n", "x", "o" }, ";", ts_repeat_move.repeat_last_move_next, { desc = "Repeat last move" })
		vim.keymap.set(
			{ "n", "x", "o" },
			",",
			ts_repeat_move.repeat_last_move_previous,
			{ desc = "Repeat last move (reverse)" }
		)

		vim.keymap.set(
			{ "n", "x", "o" },
			"f",
			ts_repeat_move.builtin_f_expr,
			{ expr = true, desc = "Find char forward" }
		)
		vim.keymap.set(
			{ "n", "x", "o" },
			"F",
			ts_repeat_move.builtin_F_expr,
			{ expr = true, desc = "Find char backward" }
		)
		vim.keymap.set(
			{ "n", "x", "o" },
			"t",
			ts_repeat_move.builtin_t_expr,
			{ expr = true, desc = "Till char forward" }
		)
		vim.keymap.set(
			{ "n", "x", "o" },
			"T",
			ts_repeat_move.builtin_T_expr,
			{ expr = true, desc = "Till char backward" }
		)
	end,
}
