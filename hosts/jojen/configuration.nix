# Host entry point for jojen (RTX 3080 Ti desktop).
# hardware-configuration.nix comes from nixos-generate-config.
{ config, pkgs, ... }:
{
  imports = [
    ./hardware-configuration.nix
    ../../modules/base.nix
    ../../modules/desktop.nix
    ../../modules/dev.nix
    ../../modules/packages.nix
    ../../modules/rustdesk.nix
  ];

  networking.hostName = "jojen";
  time.timeZone = "America/Guyana";

  # NVIDIA (RTX 3080 Ti)
  services.xserver.videoDrivers = [ "nvidia" ];
  hardware.graphics.extraPackages = with pkgs; [ nvidia-vaapi-driver ];
  hardware.nvidia = {
    modesetting.enable = true;
    open = true; # open kernel modules, recommended for RTX 20xx and newer
    nvidiaSettings = true;
    # Save/restore VRAM across suspend (nvidia-suspend/resume services); avoids
    # black screens and corrupted windows after waking. Idle clocks are automatic.
    powerManagement.enable = true;
    package = config.boot.kernelPackages.nvidiaPackages.stable;
  };
  environment.sessionVariables.NVD_BACKEND = "direct";

  # Do not change after first install.
  system.stateVersion = "26.05";
}
