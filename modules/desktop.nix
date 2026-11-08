{ pkgs, ... }:
{
  # Hyprland, started directly by the greeter (no uwsm).
  programs.hyprland = {
    enable = true;
    xwayland.enable = true;
  };

  # Login: on boot greetd autologins straight into Hyprland, which locks itself with hyprlock
  # (DOT_AUTOLOGIN, see hyprland.lua autostart), so hyprlock is the login screen.
  # After a logout greetd falls back to tuigreet.
  services.greetd = {
    enable = true;
    settings.initial_session = {
      command = "env DOT_AUTOLOGIN=1 start-hyprland";
      user = "rey";
    };
    settings.default_session = {
      command = "${pkgs.tuigreet}/bin/tuigreet --time --remember --cmd start-hyprland";
      user = "greeter";
    };
  };

  # Waybar 0.15.0 sends hyprlang-style `dispatch workspace N`, which Hyprland's Lua config
  # rejects, so workspace clicks do nothing. Upstream fix (Alexays/Waybar#5013) landed after
  # 0.15.0; drop this overlay once nixpkgs ships a newer waybar.
  nixpkgs.overlays = [
    (final: prev: {
      waybar = prev.waybar.overrideAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ../patches/waybar-lua-dispatch.patch ];
      });
    })
  ];

  xdg.portal = {
    enable = true;
    extraPortals = [ pkgs.xdg-desktop-portal-gtk ];
  };

  security.polkit.enable = true;
  # Provides the gsr-kms-server capability wrapper for promptless monitor capture.
  # The overlay UI stays disabled; dot-record starts the recorder only on demand.
  programs.gpu-screen-recorder = {
    enable = true;
    # FFmpeg 9 requires NVENC API 13.1; our 595 driver exposes 13.0.
    # Keep this compatibility override local to the recorder, with GPU encoding.
    package = pkgs.gpu-screen-recorder.override { ffmpeg = pkgs.ffmpeg_7; };
  };
  # Autologin skips the PAM password, so let hyprlock's unlock open the login keyring instead
  security.pam.services.hyprlock.enableGnomeKeyring = true;
  services.gnome.gnome-keyring.enable = true;
  security.pam.services.greetd.enableGnomeKeyring = true;

  # Audio
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
    wireplumber.enable = true;
    # Switch the graph to 44.1k for 44.1k content instead of resampling it
    extraConfig.pipewire."10-clock-rates" = {
      "context.properties"."default.clock.allowed-rates" = [ 44100 48000 ];
    };
  };

  # Bluetooth / power / misc hardware
  hardware.bluetooth.enable = true;
  hardware.bluetooth.powerOnBoot = true;
  services.power-profiles-daemon.enable = true;
  services.upower.enable = true;
  services.udisks2.enable = true;
  services.gvfs.enable = true;
  hardware.graphics.enable = true;

  # Printing
  services.printing.enable = true;
  services.avahi = {
    enable = true;
    nssmdns4 = true;
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
      vegur
      (runCommand "suse-fonts" { } ''
        mkdir -p $out/share/fonts/truetype
        cp ${../fonts}/SUSE/*.ttf ${../fonts}/SUSE-Mono/*.ttf $out/share/fonts/truetype/
      '')
    ];
    fontconfig.defaultFonts = {
      sansSerif = [ "Vegur" ];
      monospace = [ "SUSE Mono" "JetBrainsMono Nerd Font" ];
      serif = [ "Liberation Serif" ];
    };
  };

  programs.dconf.enable = true;

  # Steam via the module, not the bare package: it turns on 32-bit graphics drivers
  # (the client UI is 32-bit GL), controller udev rules and the FHS runtime.
  programs.steam.enable = true;

  # Speech synthesis for screen readers; unused, and its voices alone are ~650 MB
  services.speechd.enable = false;

  programs.gnupg.agent.enable = true;

  # Wayland env for apps (the rest lives in hyprland.conf)
  environment.sessionVariables.NIXOS_OZONE_WL = "1";
}
