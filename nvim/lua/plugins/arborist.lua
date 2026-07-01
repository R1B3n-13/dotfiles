return {
	"arborist-ts/arborist.nvim",
	event = { "BufReadPost", "BufNewFile" },
	config = function()
		local arborist = require("arborist")
		arborist.setup({
			prefer_wasm = false,
			install_popular = false,
		})
	end,
}
