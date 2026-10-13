# (config/nix-spin/wallpaper.py)
# The script stays live-editable in the repo; Nix only provides a Python with the
# GTK3 / gtk-layer-shell / librsvg typelibs wired in. `systemctl --user restart nix-spin` after edits.
{ pkgs, ... }:
let
  python = pkgs.python3.withPackages (ps: [ ps.pygobject3 ps.pycairo ps.numpy ]);

  # python3 wrapped with GI_TYPELIB_PATH etc. for the GTK libs below
  nixSpinPython = pkgs.stdenvNoCC.mkDerivation {
    name = "nix-spin-python";
    dontUnpack = true;
    dontWrapGApps = true;
    nativeBuildInputs = [ pkgs.wrapGAppsHook3 pkgs.gobject-introspection pkgs.makeWrapper ];
    buildInputs = with pkgs; [ gtk3 gtk-layer-shell librsvg ];
    installPhase = "mkdir -p $out/bin";
    postFixup = ''
      makeWrapper ${python}/bin/python3 $out/bin/nix-spin-python "''${gappsWrapperArgs[@]}"
    '';
  };
in
{
  home.packages = [ nixSpinPython ];

  systemd.user.services.nix-spin = {
    Unit = {
      Description = "Spinning ASCII NixOS wallpaper";
      PartOf = [ "graphical-session.target" ];
      After = [ "graphical-session.target" ];
    };
    Service = {
      ExecStart = "${nixSpinPython}/bin/nix-spin-python %h/.config/nix-spin/wallpaper.py";
      Environment = [ "GDK_BACKEND=wayland" ];
      Restart = "on-failure";
    };
    Install.WantedBy = [ "graphical-session.target" ];
  };
}
