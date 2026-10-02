# Host entry point. hardware-configuration.nix is generated at install time:
#   nixos-generate-config --root /mnt && cp /mnt/etc/nixos/hardware-configuration.nix hosts/nixos/
{ ... }:
{
  imports = [
    ./hardware-configuration.nix
    ../../modules/base.nix
    ../../modules/desktop.nix
    ../../modules/dev.nix
    ../../modules/packages.nix
  ];

  networking.hostName = "nixos";

  # Do not change after first install.
  system.stateVersion = "25.11";
}
