# Moonberry Setup

A generic Discord bot for game-hosting notifications. It knows about
Valheim, RuneScape: Dragonwilds, Project Zomboid and V Rising; adding another game
is one config block in `games.config.js` plus re-registering the slash
commands — no code changes.

Runs on Cloudflare Workers (same free account/pattern as your existing
Valheim coordinator) — no new hosting service to sign up for.

---

## 1. Create the Discord Application + Bot

1. Go to https://discord.com/developers/applications → **New Application**.
   Name it "Moonberry".
2. In the sidebar, go to **Bot** → **Add Bot**.
3. Under **Privileged Gateway Intents**, you don't need to enable any of
   these — Moonberry never listens to messages, only responds to slash
   commands and posts on its own.
4. Click **Reset Token** (or **Copy**) to get your **Bot Token**. Save it
   somewhere safe — this is `DISCORD_BOT_TOKEN`.
5. Go to **General Information** in the sidebar. Copy the **Public Key**
   — this is `DISCORD_PUBLIC_KEY`. Also copy the **Application ID** from
   here, you'll need it for command registration.

## 2. Invite the bot to your server

1. Go to **OAuth2** → **URL Generator**.
2. Under **Scopes**, check `bot` and `applications.commands`.
3. Under **Bot Permissions**, check `Send Messages` and `Read Message History`.
4. Copy the generated URL at the bottom, open it in a browser, and invite
   Moonberry to your server.

## 3. Get your Discord Channel ID

1. In Discord, go to **User Settings → Advanced** and turn on **Developer Mode**.
2. Right-click the channel you want Moonberry to post hosting alerts in,
   click **Copy Channel ID**.

## 4. Fill in games.config.js

Copy `games.config.example.js` to `games.config.js` (gitignored — it holds
your real channel IDs and secrets, never commit it) and fill it in:

```js
// The one coordinator every game shares.
export const COORDINATOR = {
  statusUrl: "https://moonberry-coordinator.YOUR_SUBDOMAIN.workers.dev/status",
  statusSecret: "REPLACE_WITH_YOUR_COORDINATOR_SHARED_SECRET", // the coordinator's SHARED_SECRET
  statusBinding: "COORDINATOR", // matches [[services]] in wrangler.toml
};

export const GAMES = {
  valheim: {
    displayName: "Valheim",
    emoji: "🪓",
    channelId: "PASTE_YOUR_CHANNEL_ID",
    recommendedPassword: "PASTE_YOUR_GROUP_PASSWORD", // optional
    noCodeText: "Join via Steam invite (no join code found this session)",
  },
  // dragonwilds, zomboid, vrising: see games.config.example.js
};
```

- The keys (`valheim`, `dragonwilds`, `zomboid`, `vrising`) must match the `game_id`
  the companion app sends.
- **Password line:** shown if the app sends a `password` with the
  notification, else `recommendedPassword`, else left out.
- **`noCodeText`:** the line shown when there's no join code; `""` leaves
  it out.
- **`joinCodeWaitSeconds`:** for games with join codes, how long the bot's
  own announcement waits for the code to reach the coordinator before
  posting without one (Valheim 300, Dragonwilds 660). Leave it out for
  games without codes — they're announced straight away.
- `channelId` is the default; `/set-channel` overrides it per game.

## 5. Install dependencies and deploy

```bash
cd moonberry-bot
npm install
wrangler deploy
```

The `npm install` step matters — this Worker uses the `discord-interactions`
library for signature verification (a well-tested approach, rather than
hand-rolled crypto). Skipping it will cause the deploy to fail or Discord's
"could not verify" error when you set the Interactions Endpoint URL.

Wrangler prints a URL like `https://moonberry.yoursubdomain.workers.dev`.

Then set the three secrets:

```bash
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put NOTIFY_SECRET   # make up any random string, used to
                                     # authenticate calls from your
                                     # companion apps
```

Redeploy once more after setting secrets: `wrangler deploy`.

## 6. Point Discord at your bot

1. Back in the Discord Developer Portal → **General Information**.
2. Set **Interactions Endpoint URL** to:
   `https://moonberry.yoursubdomain.workers.dev/interactions`
3. Discord will immediately test this URL (sends a ping) — if it goes
   green/saves successfully, verification worked. If it fails, double
   check the Worker deployed successfully and the public key is correct.

## 7. Register the slash commands

`/status`, `/set-channel` and `/announcements` are registered with a one-off script (not
something `wrangler deploy` does). It builds each command's game choices
from `GAMES`, so **re-run it whenever you add a game**.

You need your Application ID, your Server (Guild) ID (right-click your
server icon → Copy Server ID, with Developer Mode on) and the bot token.
In PowerShell:

```powershell
$env:DISCORD_APPLICATION_ID = "YOUR_APPLICATION_ID"
$env:DISCORD_GUILD_ID = "YOUR_SERVER_ID"
$env:DISCORD_BOT_TOKEN = "YOUR_BOT_TOKEN"
npm run commands:list       # read-only: what's registered right now
npm run commands:register   # overwrite this server's commands
```

`register` replaces all of this server's (guild) commands with the ones
in the script; global commands are left alone. Guild commands show up
instantly.

## 8. Test it

In Discord, type `/status` — Moonberry replies with everyone who's hosting
(one host per game can be hosting at once), live from the coordinator.
`/status game:Valheim` reports just Valheim's host, if any.

## 9. Hosting announcements

Moonberry checks the coordinator every minute (a Cron Trigger, set in
`wrangler.toml`) and posts "X just started / stopped hosting" in that
game's channel by itself — players don't need anything in their app's
settings. It's **off** until someone with **Manage Server** turns it on:

- `/announcements mode:on` — every game
- `/announcements mode:off game:Valheim` — just one game (a per-game
  setting wins over the all-games one; `mode:on`/`off` without a game
  clears them)

Sessions that were already running when it was turned on aren't
announced. Games with join codes wait for the code (see
`joinCodeWaitSeconds`); an announcement can be up to about a minute late.

Older companion apps still post through `POST /notify` themselves (with
the `game_id` in the body) when the bot URL and secret are filled in.
While announcements are on for a game, each side skips a session the
other one already posted.
