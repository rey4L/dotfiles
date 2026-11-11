# always reachable over Tailscale through the self-hosted server
# a root daemon that starts at boot and launches the capture/input server in the user session.
{ pkgs, ... }:
let
  rustdesk = pkgs.rustdesk-flutter;
in
{
  environment.systemPackages = [ rustdesk ];

  # Remote mouse/keyboard are injected through /dev/uinput
  hardware.uinput.enable = true;

  systemd.services.rustdesk = {
    description = "RustDesk host service";
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" ];
    after = [ "network-online.target" "systemd-user-sessions.service" "tailscaled.service" ];
    # The daemon shells out to loginctl/ps/sudo etc. to find the session and start its user-side server
    path = [ "/run/wrappers" rustdesk ] ++ (with pkgs; [ coreutils gnugrep gawk procps systemd util-linux ]);
    # Don't restart on rebuild: it kills the server-spawned --tray, the only process the daemon can still
    # read DISPLAY from under Hyprland (no XAUTHORITY), so the new server comes up without a display and the
    # uinput mouse falls back to 1920x1080 (remote cursor misaligned). New versions apply on reboot.
    restartIfChanged = false;
    serviceConfig = {
      ExecStart = "${rustdesk}/bin/rustdesk --service";
      Restart = "always";
      RestartSec = 5;
      KillMode = "mixed";
      TimeoutStopSec = 30;
      LimitNOFILE = 100000;
    };
  };

  # Direct (non-relayed) connections from tailnet peers only; nothing exposed on other interfaces
  networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 21118 21119 ];
}
