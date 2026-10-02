{ config, lib, pkgs, ... }:
let
  # Live-edit: link straight into the checked-out repo (no rebuild needed for config tweaks).
  repo = "${config.home.homeDirectory}/dotfiles";
  link = path: config.lib.file.mkOutOfStoreSymlink "${repo}/${path}";

  configDirs = [
    "hypr" "waybar" "mako" "walker" "swayosd" "ghostty" "nvim" "btop"
    "fastfetch" "lazygit" "imv" "fontconfig" "uwsm"
  ];
  configFiles = [
    "starship.toml" "mimeapps.list" "xdg-terminals.list"
    "chromium-flags.conf" "brave-flags.conf"
  ];
  binScripts = builtins.attrNames (builtins.readDir ../bin);
in
{
  home.username = "rey";
  home.homeDirectory = "/home/rey";
  home.stateVersion = "25.11";
  programs.home-manager.enable = true;

  xdg.configFile =
    lib.genAttrs configDirs (d: { source = link "config/${d}"; })
    // lib.genAttrs configFiles (f: { source = link "config/${f}"; })
    // {
      "tmux/tmux.conf".source = link "config/tmux/tmux.conf";
    };

  home.file =
    lib.listToAttrs (map (n: lib.nameValuePair ".local/bin/${n}" { source = link "bin/${n}"; }) binScripts)
    // {
      ".inputrc".source = link "config/bash/inputrc";
    };

  # tmux theme plugin (tmux.conf sources it from ~/.config/tmux/plugins)
  home.activation.catppuccinTmux = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    dir="$HOME/.config/tmux/plugins/catppuccin/tmux"
    if [ ! -f "$dir/catppuccin.tmux" ]; then
      run ${pkgs.git}/bin/git clone --depth 1 https://github.com/catppuccin/tmux.git "$dir"
    fi
  '';

  home.sessionVariables = {
    EDITOR = "nvim";
    SUDO_EDITOR = "nvim";
    TERMINAL = "ghostty";
    BAT_THEME = "ansi";
    MANROFFOPT = "-c";
    MANPAGER = "sh -c 'col -bx | bat -l man -p'";
  };
  home.sessionPath = [ "$HOME/.local/bin" ];

  # --- Shell
  programs.bash = {
    enable = true;
    historyControl = [ "ignoreboth" ];
    historySize = 32768;
    historyFileSize = 32768;
    shellAliases = {
      ls = "eza -lh --group-directories-first --icons=auto";
      lsa = "ls -a";
      lt = "eza --tree --level=2 --long --icons --git";
      lta = "lt -a";
      ff = "fzf --preview 'bat --style=numbers --color=always {}'";
      eff = ''$EDITOR "$(ff)"'';
      ".." = "cd ..";
      "..." = "cd ../..";
      "...." = "cd ../../..";
      d = "docker";
      t = "tmux attach || tmux new -s Work";
      g = "git";
      gcm = "git commit -m";
      gcam = "git commit -a -m";
      gcad = "git commit -a --amend";
      cx = ''printf "\033[2J\033[3J\033[H" && claude --permission-mode bypassPermissions'';
      mup = "MISE_MINIMUM_RELEASE_AGE=0 mise up";
    };
    initExtra = ''
      set +h # command hashing off (mise)
      open() ( xdg-open "$@" >/dev/null 2>&1 & )
      n() { if [ "$#" -eq 0 ]; then command nvim . ; else command nvim "$@"; fi; }
      sff() { if [ $# -eq 0 ]; then echo "Usage: sff <destination> (e.g. sff host:/tmp/)"; return 1; fi; local file; file=$(find . -type f -printf '%T@\t%p\n' | sort -rn | cut -f2- | ff) && [ -n "$file" ] && scp "$file" "$1"; }

      # zoxide-backed cd
      zd() {
        if (( $# == 0 )); then builtin cd ~ || return
        elif [[ -d $1 ]]; then builtin cd "$1" || return
        else
          if ! z "$@"; then echo "Error: Directory not found"; return 1; fi
          printf "\U000F17A9 "; pwd
        fi
      }
      alias cd=zd

      for f in ~/dotfiles/config/bash/fns/*; do source "$f"; done

      # Machine-local extras (not tracked): put secrets/paths in ~/.bashrc.local
      [ -f ~/.bashrc.local ] && source ~/.bashrc.local
    '';
  };
  programs.starship.enable = true; # config comes from config/starship.toml
  programs.zoxide.enable = true;
  programs.fzf.enable = true;
  programs.mise = {
    enable = true;
    enableBashIntegration = true;
  };

  # --- Git (from ~/.config/git/config)
  programs.git = {
    enable = true;
    settings = {
      user = {
        name = "Reynard Etwaroo";
        email = "reynardetwaroo4@gmail.com";
      };
      alias = {
        co = "checkout";
        br = "branch";
        ci = "commit";
        st = "status";
      };
      init.defaultBranch = "master";
      pull.rebase = true;
      push.autoSetupRemote = true;
      diff = {
        algorithm = "histogram";
        colorMoved = "plain";
        mnemonicPrefix = true;
      };
      commit.verbose = true;
      column.ui = "auto";
      branch.sort = "-committerdate";
      tag.sort = "-version:refname";
      rerere = {
        enabled = true;
        autoupdate = true;
      };
      credential."https://github.com".helper = [ "" "!${pkgs.gh}/bin/gh auth git-credential" ];
      credential."https://gist.github.com".helper = [ "" "!${pkgs.gh}/bin/gh auth git-credential" ];
    };
  };

  # --- Theme
  gtk = {
    enable = true;
    font = { name = "SUSE"; size = 11; };
    theme = { name = "Adwaita-dark"; package = pkgs.gnome-themes-extra; };
    gtk3.extraConfig.gtk-application-prefer-dark-theme = true;
    gtk4.extraConfig.gtk-application-prefer-dark-theme = true;
  };
  dconf.settings."org/gnome/desktop/interface".color-scheme = "prefer-dark";
}
