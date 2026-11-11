{
  description = "rey's NixOS + Home Manager setup (Hyprland, Catppuccin Mocha)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Secure Boot (signed systemd-boot + UKIs) so Windows anti-cheat games run.
    lanzaboote = {
      url = "github:nix-community/lanzaboote/v1.2.0";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, home-manager, lanzaboote, ... }: {
    nixosConfigurations.jojen = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./hosts/jojen/configuration.nix
        lanzaboote.nixosModules.lanzaboote
        home-manager.nixosModules.home-manager
        ({ pkgs, ... }: {
          home-manager.useGlobalPkgs = true;
          home-manager.useUserPackages = true;
          # Timestamped backups never collide, so a file in the way of a link
          # can't abort activation (a fixed ".backup" name did on 2026-10-12).
          home-manager.backupCommand = pkgs.writeShellScript "hm-backup" ''
            mv -- "$1" "$1.hm-backup-$(date +%Y%m%d-%H%M%S)"
          '';
          home-manager.users.rey = import ./home/home.nix;
        })
      ];
    };
  };
}
