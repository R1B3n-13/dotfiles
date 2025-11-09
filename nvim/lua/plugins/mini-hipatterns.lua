return {
	"echasnovski/mini.hipatterns",
	event = { "BufReadPre", "BufNewFile" },
	version = "*",
	config = function()
		local hipatterns = require("mini.hipatterns")

		hipatterns.setup({
			highlighters = {
				-- Highlight '(FIXME)', '(HACK)', '(TODO)', '(NOTE)'
				fixme = {
					pattern = "%(()FIXME()%)",
					group = "MiniHipatternsFixme",
				},
				hack = {
					pattern = "%(()HACK()%)",
					group = "MiniHipatternsHack",
				},
				todo = {
					pattern = "%(()TODO()%)",
					group = "MiniHipatternsTodo",
				},
				note = {
					pattern = "%(()NOTE()%)",
					group = "MiniHipatternsNote",
				},
			},
		})
	end,
}
