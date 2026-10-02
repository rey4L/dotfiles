{ pkgs, ... }:
{
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;
  boot.loader.systemd-boot.configurationLimit = 10;
  zramSwap.enable = true;

  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    auto-optimise-store = true;
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };
  nixpkgs.config.allowUnfree = true;

  networking.networkmanager.enable = true;
  networking.firewall.enable = true;

  services.automatic-timezoned.enable = true; # replaces Arch's tzupdate
  i18n.defaultLocale = "en_US.UTF-8";

  users.users.rey = {
    isNormalUser = true;
    description = "Reynard Etwaroo";
    extraGroups = [ "wheel" "networkmanager" "docker" "video" "input" "audio" ];
    shell = pkgs.bash;
  };

  services.openssh.enable = false;
  services.fwupd.enable = true;
  services.locate = {
    enable = true;
    package = pkgs.plocate;
  };
}
