return {
	"folke/flash.nvim",
	event = "VeryLazy",
	opts = { labels = "asdfghjklqwertyuiopzxcvbnm1230984756" },
	keys = {
		{
			"r",
			mode = { "n", "x", "o" },
			function()
				require("flash").jump()
			end,
			desc = "Flash",
		},
	},
}
