-- Learning Go by hand: keep Copilot ghost text out of these filetypes.
-- Delete this file to re-enable Copilot everywhere.
return {
  {
    "zbirenbaum/copilot.lua",
    opts = {
      filetypes = {
        go = false,
        gomod = false,
        gowork = false,
        gosum = false,
        sql = false,
        http = false,
      },
    },
  },
}
