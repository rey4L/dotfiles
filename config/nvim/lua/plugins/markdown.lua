-- Lightweight markdown reading: render headings, checkboxes, tables and code
-- blocks in the buffer. No LSP, no markdownlint.
-- Docs: https://github.com/MeanderingProgrammer/render-markdown.nvim
-- Toggle: <leader>um (or :RenderMarkdown toggle)
return {
  {
    "MeanderingProgrammer/render-markdown.nvim",
    ft = { "markdown" },
    dependencies = { "nvim-treesitter/nvim-treesitter" },
    opts = {
      code = {
        sign = false,
        width = "block",
        right_pad = 1,
      },
      heading = {
        sign = false,
      },
      checkbox = {
        enabled = true,
      },
      completions = {
        lsp = { enabled = false },
      },
    },
    config = function(_, opts)
      require("render-markdown").setup(opts)
      Snacks.toggle({
        name = "Render Markdown",
        get = require("render-markdown").get,
        set = require("render-markdown").set,
      }):map("<leader>um")
    end,
  },

  {
    "mfussenegger/nvim-lint",
    optional = true,
    opts = function(_, opts)
      opts.linters_by_ft = opts.linters_by_ft or {}
      opts.linters_by_ft.markdown = {}
    end,
  },
}
