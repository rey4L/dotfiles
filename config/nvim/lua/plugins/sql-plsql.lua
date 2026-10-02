return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        sqlls = {
          filetypes = { "sql", "mysql", "plsql" },
        },
      },
    },
  },

  {
    "mason-org/mason.nvim",
    opts = function(_, opts)
      opts.ensure_installed = opts.ensure_installed or {}
      if not vim.tbl_contains(opts.ensure_installed, "sqlls") then
        table.insert(opts.ensure_installed, "sqlls")
      end
    end,
  },

  {
    "nvim-treesitter/nvim-treesitter",
    optional = true,
    opts = function(_, opts)
      opts.ensure_installed = opts.ensure_installed or {}
      if not vim.tbl_contains(opts.ensure_installed, "sql") then
        table.insert(opts.ensure_installed, "sql")
      end
    end,
  },

  {
    "mfussenegger/nvim-lint",
    optional = true,
    opts = function(_, opts)
      opts.linters_by_ft = opts.linters_by_ft or {}
      opts.linters_by_ft.sql = {}
      opts.linters_by_ft.mysql = {}
      opts.linters_by_ft.plsql = {}
    end,
  },

  {
    "LazyVim/LazyVim",
    init = function()
      vim.filetype.add({
        extension = {
          bdy = "plsql",
          ddl = "plsql",
          fnc = "plsql",
          pck = "plsql",
          pkb = "plsql",
          pks = "plsql",
          plb = "plsql",
          pls = "plsql",
          prc = "plsql",
          spc = "plsql",
          tpb = "plsql",
          tps = "plsql",
          trg = "plsql",
          vw = "plsql",
        },
      })
    end,
  },
}
