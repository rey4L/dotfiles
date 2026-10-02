{ pkgs, ... }:
{
  virtualisation.docker.enable = true;
  services.tailscale.enable = true;
  networking.networkmanager.plugins = [ pkgs.networkmanager-vpnc ];
  services.strongswan.enable = true;

  # Dynamically linked binaries (mise-installed toolchains, vendor CLIs).
  programs.nix-ld.enable = true;
}
