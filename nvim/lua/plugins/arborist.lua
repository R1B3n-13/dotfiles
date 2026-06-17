return {
	"arborist-ts/arborist.nvim",
	config = function()
		local arborist = require("arborist")
		arborist.setup({
			prefer_wasm = false,
			install_popular = false,
		})
	end,
}
