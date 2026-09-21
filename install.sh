#!/usr/bin/env bash
# Symlink every tracked dotfile into $HOME, preserving directory structure.
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

link starship.toml   .config/starship.toml
link ghostty/config  .config/ghostty/config
link tmux/tmux.conf  .config/tmux/tmux.conf

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
