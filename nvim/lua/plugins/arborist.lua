return {
	"arborist-ts/arborist.nvim",
	config = function()
		local config = require("arborist")
		config.setup({
			prefer_wasm = false,
			install_popular = false,
		})
	end,
}
