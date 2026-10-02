#!/usr/bin/env bash
# Non-Nix fallback: symlink configs + helper scripts into $HOME.
# On NixOS, Home Manager (home/home.nix) does the same thing — don't run this there.
# Existing regular files are moved aside to <file>.backup before linking.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

link() {
  local src="$repo/$1" dest="$HOME/$2"

  mkdir -p "$(dirname "$dest")"

  if [[ -L "$dest" ]]; then
    [[ "$(readlink -f "$dest")" == "$src" ]] && { echo "ok      $2"; return; }
    rm "$dest"
  elif [[ -e "$dest" ]]; then
    mv "$dest" "$dest.backup"
    echo "backup  $2 -> $2.backup"
  fi

  ln -s "$src" "$dest"
  echo "link    $2"
}

for d in hypr waybar mako walker swayosd ghostty nvim btop fastfetch lazygit imv fontconfig uwsm; do
  link "config/$d" ".config/$d"
done
for f in starship.toml mimeapps.list xdg-terminals.list chromium-flags.conf brave-flags.conf; do
  link "config/$f" ".config/$f"
done
link config/tmux/tmux.conf .config/tmux/tmux.conf
link config/bash/inputrc   .inputrc

for s in "$repo"/bin/*; do
  link "bin/$(basename "$s")" ".local/bin/$(basename "$s")"
done

mkdir -p "$HOME/.local/share/fonts"
for f in SUSE SUSE-Mono; do
  link "fonts/$f" ".local/share/fonts/$f"
done

catppuccin_tmux="$HOME/.config/tmux/plugins/catppuccin/tmux"
if [[ -f "$catppuccin_tmux/catppuccin.tmux" ]]; then
  echo "ok      Catppuccin tmux plugin"
elif [[ -e "$catppuccin_tmux" ]]; then
  echo "error   $catppuccin_tmux exists but is not a valid plugin checkout" >&2
  exit 1
else
  command -v git >/dev/null || {
    echo "error   git is required to install the Catppuccin tmux plugin" >&2
    exit 1
  }
  git clone --depth 1 https://github.com/catppuccin/tmux.git "$catppuccin_tmux"
  echo "install Catppuccin tmux plugin"
fi
