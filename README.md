# discord-bot
```bash
bun install
bun start
```

## usage on a server (NixOS)
```nix
{
  systemd.services.discord-bot = {
    enable = true;
    wantedBy = ["multi-user.target"];
    wants = ["network-online.target"];
    after = ["network-online.target"];
    path = with pkgs; [ git bun yt-dlp ffmpeg ];
    script = "git pull && bun i --frozen-lockfile && bun start";
    serviceConfig = {
      User = "cassie"; # the user you used to clone the repo
      WorkingDirectory = "/home/cassie/discord-bot"; # the directory you cloned the repo to
      Restart = "on-failure";
      RestartSec = 5;
      StandardOutput = "journal";
      StandardError = "journal";
    };
  };
}
```
