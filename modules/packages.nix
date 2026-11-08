# System packages, mapped from the Arch `pacman -Qqen` / AUR list.
# Attribute names target nixos-unstable; run `nix flake check` after edits.
{ pkgs, ... }:
{
  environment.systemPackages = with pkgs; [
    # --- Hyprland desktop
    ghostty
    waybar
    mako
    swaybg
    swayosd
    hyprlock
    hyprsunset
    hyprpicker
    hyprpolkitagent
    hyprland-preview-share-picker
    grim
    slurp
    satty
    wl-clipboard
    cliphist
    fuzzel
    rofi # clipboard picker with image thumbnails (dot-clipboard)
    pamixer
    pipewire.jack # pw-jack: run JACK apps on PipeWire (`pw-jack <app>`)
    playerctl
    wiremix
    bluetui
    libnotify
    wev
    evtest
    kdePackages.qtstyleplugin-kvantum
    libsForQt5.qtstyleplugin-kvantum
    gnome-themes-extra
    adwaita-icon-theme

    # --- Files / media
    nautilus
    gvfs
    gnome-calculator
    gnome-disk-utility
    evince
    imv
    mpv-unwrapped
    ffmpeg
    ffmpegthumbnailer
    imagemagick
    yazi

    # --- CLI
    neovim
    tmux
    starship
    zoxide
    fzf
    eza
    bat
    fd
    ripgrep
    jq
    dust
    gum
    btop-cuda # btop with NVIDIA GPU support (NVML)
    heroic
    fastfetch
    lazydocker
    mise
    git
    gh
    tldr
    unzip
    zip
    curl
    wget
    socat
    inetutils
    whois
    inxi
    xmlstarlet
    tree-sitter
    luarocks
    dosfstools
    exfatprogs
    btrfs-progs
    tailscale

    # --- Languages / toolchains (mise handles per-project versions)
    # Global defaults so LazyVim works: treesitter compiles parsers with gcc,
    # Mason installs LSPs/formatters with go (gopls…), npm (jsonls, dockerls, sqlls…) and pip (sqlfluff).
    gcc
    gnumake
    go
    nodejs
    python3

    # --- Cloud / dev tools
    docker-compose
    docker-buildx
    claude-code

    # --- Apps
    chromium
    keepassxc
    discord
    hubstaff
    qbittorrent
  ];
}
