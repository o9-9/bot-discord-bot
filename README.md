# discord-bot
```bash
bun install
bun start
```

## Features
### `/gemini`
- `input`: what you want to ask / say to gemini
- `thinking`: how much thinking tokens to use for reply,
  - [0 - none (default), 1k - low, 4k - medium, 16k high]
  - only users with ids within `PRO_USER_IDS` can use 16k high

### `/download`
- `url`: the media to download, can be anything supported by yt-dlp, also has custom support added for reddit gifs and galleries
- `clip-start` and `clip-end`: used to cut a video down to a shorter segment, formatted as either `XXhXXmXXs` (ex: `2h15m3s`) or a number of seconds

### `/image`
- `query`: google image search query
- `count`: number of images to return (number between 1-10, defaults to 5)

### `/dictionary`
- `term`: word/term to define, uses Merriam-Webster's dictionary
- use `<` and `>` buttons attached to message to browse different definitions

### `/urbandictionary`
- identical to `/dictionary`, but uses https://unofficialurbandictionaryapi.com/

## usage on a server (NixOS)
Create `.env` (`cp .env.example .env`) and fill in relevant values:
- `TOKEN`: from https://discord.com/developers/applications
- `GEMINI_KEY`: from https://aistudio.google.com/app/projects
- `DICTIONARY_KEY`: from https://www.dictionaryapi.com/register/index
- `PRO_USER_IDS`: comma separated list of discord user ids that you want to be able to use the highest tier of thinking on `/gemini`
- `TEST`: present with any value if you want all commands to be prefixed with `test_`, helpful for differentiating your development build from production

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
