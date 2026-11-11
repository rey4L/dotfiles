{ pkgs, lib, ... }:
{
  # Lanzaboote replaces the systemd-boot module (still systemd-boot, but signed).
  boot.loader.systemd-boot.enable = false;
  boot.lanzaboote = {
    enable = true;
    pkiBundle = "/var/lib/sbctl"; # keys from `sudo sbctl create-keys`
  };
  environment.systemPackages = [ pkgs.sbctl ];
  boot.loader.efi.canTouchEfiVariables = true;
  boot.loader.systemd-boot.configurationLimit = 3; # boot menu: current + 2 previous builds
  zramSwap.enable = true;

  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    auto-optimise-store = true;
    http-connections = 64; # default 25
    max-substitution-jobs = 32; # default 16
    download-buffer-size = 268435456; # 256 MiB; default 1 MiB can stall downloads
    connect-timeout = 5;
    use-xdg-base-directories = true; # ~/.nix-profile, ~/.nix-defexpr -> ~/.local/state/nix
  };

  # Keep $HOME clean: point tools that default to ~/.<name> at the XDG dirs.
  # Set via PAM so GUI apps started from Hyprland get them too, not just shells.
  environment.sessionVariables = {
    XDG_CONFIG_HOME = "$HOME/.config";
    XDG_CACHE_HOME = "$HOME/.cache";
    XDG_DATA_HOME = "$HOME/.local/share";
    XDG_STATE_HOME = "$HOME/.local/state";
    GOPATH = "$HOME/.local/share/go"; # was ~/go
    GOMODCACHE = "$HOME/.cache/go/mod";
    NPM_CONFIG_CACHE = "$HOME/.cache/npm"; # was ~/.npm
    CUDA_CACHE_PATH = "$HOME/.cache/nv"; # was ~/.nv
    __GL_SHADER_DISK_CACHE_PATH = "$HOME/.cache/nv";
    INPUTRC = "$HOME/.config/readline/inputrc"; # was ~/.inputrc
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };
  nixpkgs.config.allowUnfree = true;

  networking.networkmanager.enable = true;
  networking.firewall.enable = true;
  # NetworkManager Wi-Fi hotspot on wlp7s0: let clients reach its dnsmasq
  # for DHCP (67) and DNS (53), otherwise they hang on "connecting".
  networking.firewall.interfaces.wlp7s0 = {
    allowedUDPPorts = [ 53 67 ];
    allowedTCPPorts = [ 53 ];
  };

  # /etc/nixos points at this repo, so a bare `nixos-rebuild switch` or
  # `--flake /etc/nixos#jojen` builds the real config instead of a stale one.
  systemd.tmpfiles.rules = [ "L+ /etc/nixos - - - - /home/rey/dotfiles" ];

  # Mullvad VPN: daemon + CLI, plus GUI app
  services.mullvad-vpn = {
    enable = true;
    gui.enable = true;
  };
  # Do not start the daemon at boot (unlike tailscaled). Start on demand with
  # `sudo systemctl start mullvad-daemon`; the GUI/CLI need it running.
  systemd.services.mullvad-daemon.wantedBy = lib.mkForce [ ];

  i18n.defaultLocale = "en_US.UTF-8";
  i18n.supportedLocales = [ "en_US.UTF-8/UTF-8" ]; # not every locale (~220 MB)

  users.users.rey = {
    isNormalUser = true;
    description = "Reynard Etwaroo";
    extraGroups = [ "wheel" "networkmanager" "docker" "video" "input" "audio" ];
    shell = pkgs.bash;
  };

  # Allow dot-power (SUPER+O) to set one-shot UEFI BootNext for Windows without a password prompt.
  security.sudo.extraRules = [
    {
      users = [ "rey" ];
      commands = [
        {
          command = "/run/current-system/sw/bin/efibootmgr";
          options = [ "NOPASSWD" ];
        }
      ];
    }
  ];

  services.openssh.enable = false;
  services.fwupd.enable = true;
  services.locate = {
    enable = true;
    package = pkgs.plocate;
  };
}
