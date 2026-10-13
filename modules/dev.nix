{ pkgs, ... }:
{
  virtualisation.docker.enable = true;
  services.tailscale.enable = true;

  # Dynamically linked binaries (mise-installed toolchains, vendor CLIs).
  programs.nix-ld.enable = true;
}
