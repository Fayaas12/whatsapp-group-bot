# WhatsApp Group Bot

A powerful WhatsApp group bot built with Baileys. It supports:

- YouTube video downloading
- TikTok video downloading
- group spam detection and auto-ban
- manual admin bans and unbans
- command-based media handling

## Requirements

- Node.js 18+
- FFmpeg installed and available on PATH
- `yt-dlp` installed and available on PATH

## Install

```bash
npm install
python -m pip install yt-dlp
```

On Windows, you can also install `yt-dlp.exe` and make sure it is in PATH.

## Setup

```bash
cp .env.example .env
```

Then edit `.env` and set your values.

## Start the bot

```bash
npm start
```

## Commands in the group

- `!help` - Show all commands
- `!yt <url>` - Download and send a YouTube video
- `!tt <url>` or `!tiktok <url>` - Download and send a TikTok video
- `!ban @user` - Ban a user from the group (admin only)
- `!unban @user` - Unban a user (admin only)
- `!spamstatus` - Show spam protection status

## Notes

- The bot needs to be added to the group as an admin for ban and removal actions.
- YouTube/TikTok content may be restricted by platform terms or regional availability.
- Keep the bot rate-limited and avoid using it for mass spam or abusive behavior.
