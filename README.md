# dotfiles

NixOS flake + Home Manager config for my Hyprland desktop (Catppuccin Mocha, SUSE Mono).
Raw configs live in `config/` and are symlinked into `~` by Home Manager, so editing
a file takes effect without a rebuild.

## Layout

| Path | What |
|---|---|
| `flake.nix` | `nixosConfigurations.nixos` (NixOS + Home Manager) |
| `hosts/nixos/` | host entry; `hardware-configuration.nix` is generated at install |
| `modules/` | `base` (boot, nix, user), `desktop` (Hyprland, audio, fonts, greetd), `dev` (docker, tailscale), `packages` |
| `home/home.nix` | Home Manager: links `config/*`, `bin/*`, bash, git, gtk |
| `config/` | hypr (conf/idle/lock/sunset + wallpaper), waybar, mako, walker, swayosd, ghostty, tmux, nvim, btop, fastfetch, lazygit, imv, starship, … |
| `bin/` | `dot-*` helpers (launch-or-focus, webapp, screenshot, lock, toggles, …) → `~/.local/bin` |
| `fonts/` | SUSE + SUSE Mono (not in nixpkgs) |

Hyprland config is standalone hyprlang (`config/hypr/hyprland.conf`) — no Omarchy dependency.

## Non-Nix (Arch etc.)

`./install.sh` symlinks the same `config/`, `bin/` and fonts into `$HOME` and fetches the
Catppuccin tmux plugin. Needs `tmux`, `starship`, `git`, a Nerd Font, and the tools the
scripts call (`hyprland`, `jq`, `grim`, `slurp`, `satty`, `walker`, …).
