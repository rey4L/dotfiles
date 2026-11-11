# Host entry point for jojen (RTX 3080 Ti desktop).
# hardware-configuration.nix comes from nixos-generate-config.
{ config, lib, pkgs, ... }:
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

  # NVIDIA (RTX 3080 Ti) — default bare-metal configuration
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

  # Boot menu entry for running inside VMware Workstation (or on the Intel UHD 770 iGPU)
  # without touching the default bare-metal NVIDIA configuration.
  specialisation.vmware.configuration = {
    system.nixos.tags = [ "vmware" ];

    # Replace NVIDIA driver with VMware / Intel modesetting drivers
    services.xserver.videoDrivers = lib.mkForce [ "modesetting" "vmware" ];
    hardware.nvidia.modesetting.enable = lib.mkForce false;
    hardware.nvidia.nvidiaSettings = lib.mkForce false;
    hardware.nvidia.powerManagement.enable = lib.mkForce false;
    boot.blacklistedKernelModules = [ "nvidia" "nvidia_drm" "nvidia_modeset" "nvidia_uvm" ];

    # Intel UHD 770 (i5-12600K) VA-API support + VMware guest drivers
    hardware.graphics.extraPackages = lib.mkForce (with pkgs; [
      intel-media-driver
      vpl-gpu-rt
    ]);

    # VMware guest additions (open-vm-tools: clipboard, mouse, display resize)
    virtualisation.vmware.guest.enable = true;

    # Include VMware SCSI/PVSCSI drivers in initrd so the disk boots regardless of VMware controller type
    boot.initrd.availableKernelModules = [ "mptspi" "vmw_pvscsi" "ata_piix" ];

    # Ensure cursor is visible in Hyprland under VMware's virtual GPU
    environment.sessionVariables = {
      NVD_BACKEND = lib.mkForce "";
      AQ_NO_HARDWARE_CURSORS = "1";
      WLR_NO_HARDWARE_CURSORS = "1";
    };
  };

  # Do not change after first install.
  system.stateVersion = "26.05";
}
