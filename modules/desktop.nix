{ pkgs, ... }:
{
  # Hyprland through uwsm (matches the Omarchy session setup).
  programs.hyprland = {
    enable = true;
    withUWSM = true;
    xwayland.enable = true;
  };

  # Login: tuigreet -> uwsm-managed Hyprland session.
  services.greetd = {
    enable = true;
    settings.default_session = {
      command = "${pkgs.tuigreet}/bin/tuigreet --time --remember --cmd 'uwsm start hyprland-uwsm.desktop'";
      user = "greeter";
    };
  };

  xdg.portal = {
    enable = true;
    extraPortals = [ pkgs.xdg-desktop-portal-gtk ];
  };

  security.polkit.enable = true;
  security.pam.services.hyprlock = { };
  services.gnome.gnome-keyring.enable = true;
  security.pam.services.greetd.enableGnomeKeyring = true;

  # Audio
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
    jack.enable = true;
    wireplumber.enable = true;
  };

  # Bluetooth / power / misc hardware
  hardware.bluetooth.enable = true;
  hardware.bluetooth.powerOnBoot = true;
  services.power-profiles-daemon.enable = true;
  services.upower.enable = true;
  services.thermald.enable = true;
  services.udisks2.enable = true;
  services.gvfs.enable = true;
  hardware.graphics.enable = true;
  hardware.graphics.enable32Bit = true; # steam

  # Printing
  services.printing.enable = true;
  services.avahi = {
    enable = true;
    nssmdns4 = true;
  };

  # Input method (fcitx5 started from hyprland.conf autostart)
  i18n.inputMethod = {
    enable = true;
    type = "fcitx5";
    fcitx5.waylandFrontend = true;
  };

  # Fonts. SUSE / SUSE Mono are vendored in ./fonts (not in nixpkgs).
  fonts = {
    packages = with pkgs; [
      nerd-fonts.jetbrains-mono
      noto-fonts
      noto-fonts-cjk-sans
      noto-fonts-color-emoji
      font-awesome
      liberation_ttf
      (runCommand "suse-fonts" { } ''
        mkdir -p $out/share/fonts/truetype
        cp ${../fonts}/SUSE/*.ttf ${../fonts}/SUSE-Mono/*.ttf $out/share/fonts/truetype/
      '')
    ];
    fontconfig.defaultFonts = {
      sansSerif = [ "SUSE" ];
      monospace = [ "SUSE Mono" "JetBrainsMono Nerd Font" ];
      serif = [ "Liberation Serif" ];
    };
  };

  programs.dconf.enable = true;
  programs.steam.enable = true;
  programs.gnupg.agent.enable = true;

  # Wayland env for apps (the rest lives in hyprland.conf)
  environment.sessionVariables.NIXOS_OZONE_WL = "1";
}
