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
