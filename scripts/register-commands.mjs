// scripts/register-commands.mjs
// -----------------------------------------------------------------------
// Registers Moonberry's slash commands (/status, /set-channel) with
// Discord, with the game choices built from GAMES in games.config.js.
// Re-run after adding a game. Deploying the Worker does NOT do this.
//
//   npm run commands:list       read-only: show what's registered now
//   npm run commands:register   overwrite this server's commands
//
// Needs these environment variables (never hardcode them):
//   DISCORD_APPLICATION_ID   Developer Portal -> General Information
//   DISCORD_GUILD_ID         right-click your server -> Copy Server ID
//   DISCORD_BOT_TOKEN        Developer Portal -> Bot
//
// "register" uses Discord's bulk overwrite for guild commands: any guild
// command NOT in the list below is removed. Global commands are untouched.
// -----------------------------------------------------------------------

import { GAMES } from "../games.config.js";

const API = "https://discord.com/api/v10";
const STRING_OPTION = 3;

const { DISCORD_APPLICATION_ID: appId, DISCORD_GUILD_ID: guildId, DISCORD_BOT_TOKEN: token } = process.env;
if (!appId || !guildId || !token) {
  console.error("Set DISCORD_APPLICATION_ID, DISCORD_GUILD_ID and DISCORD_BOT_TOKEN first.");
  process.exit(1);
}

const gameChoices = Object.entries(GAMES).map(([key, game]) => ({ name: game.displayName, value: key }));

const COMMANDS = [
  {
    name: "status",
    description: "Check who is currently hosting",
    options: [
      {
        name: "game",
        description: "Which game to check (leave out to see whatever is being hosted)",
        type: STRING_OPTION,
        required: false,
        choices: gameChoices,
      },
    ],
  },
  {
    name: "set-channel",
    description: "Post this game's hosting notifications in this channel",
    options: [
      {
        name: "game",
        description: "Which game's notifications to move here",
        type: STRING_OPTION,
        required: true,
        choices: gameChoices,
      },
    ],
  },
];

async function discord(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

function describe(commands) {
  if (!commands.length) return "  (none)";
  return commands
    .map((c) => {
      const choices = c.options?.find((o) => o.name === "game")?.choices?.map((ch) => ch.value) || [];
      return `  /${c.name}  games: ${choices.join(", ") || "-"}`;
    })
    .join("\n");
}

const mode = process.argv[2];
if (mode === "list") {
  console.log("Guild commands:\n" + describe(await discord("GET", `/applications/${appId}/guilds/${guildId}/commands`)));
  console.log("Global commands:\n" + describe(await discord("GET", `/applications/${appId}/commands`)));
} else if (mode === "register") {
  const result = await discord("PUT", `/applications/${appId}/guilds/${guildId}/commands`, COMMANDS);
  console.log("Registered guild commands:\n" + describe(result));
} else {
  console.error('Usage: node scripts/register-commands.mjs <list|register>');
  process.exit(1);
}
