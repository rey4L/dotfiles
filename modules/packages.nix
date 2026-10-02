# System packages, mapped from the Arch `pacman -Qqen` / AUR list.
# Attribute names target nixos-unstable; run `nix flake check` after edits.
{ pkgs, ... }:
{
  environment.systemPackages = with pkgs; [
    # --- Hyprland desktop
    ghostty
    waybar
    mako
    walker
    elephant
    swaybg
    swayosd
    hypridle
    hyprlock
    hyprsunset
    hyprpicker
    hyprpolkitagent
    hyprland-preview-share-picker
    grim
    slurp
    satty
    wl-clipboard
    gpu-screen-recorder
    brightnessctl
    pamixer
    playerctl
    wiremix
    impala
    bluetui
    libnotify
    qalculate-gtk
    libqalculate
    wev
    evtest
    kdePackages.qtstyleplugin-kvantum
    libsForQt5.qtstyleplugin-kvantum
    gnome-themes-extra
    yaru-theme
    adwaita-icon-theme

    # --- Files / media
    nautilus
    sushi
    gvfs
    gnome-calculator
    gnome-disk-utility
    evince
    imv
    mpv
    ffmpeg
    ffmpegthumbnailer
    imagemagick
    tesseract
    yazi
    localsend

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
    btop
    fastfetch
    lazygit
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
    powertop
    xmlstarlet
    tree-sitter
    luarocks
    dosfstools
    exfatprogs
    btrfs-progs

    # --- Languages / toolchains (mise handles per-project versions)
    gcc
    clang
    llvm
    rustc
    cargo
    ruby
    python3
    dotnet-runtime_9
    postgresql
    mariadb-connector-c

    # --- Cloud / dev tools
    awscli2
    google-cloud-sdk
    docker-compose
    docker-buildx
    bruno
    dbeaver-bin
    quickemu
    qemu
    rustdesk
    claude-code

    # --- Apps
    chromium
    brave
    vscode
    obsidian
    typora
    spotify
    signal-desktop
    teams-for-linux
    keepassxc
    xournalpp
    pinta
    gimp
    kdePackages.kdenlive
    obs-studio
    libreoffice-fresh
    openrgb
  ];
}
