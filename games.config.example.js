// games.config.example.js
// -----------------------------------------------------------------------
// TEMPLATE ONLY -- copy this file to games.config.js and fill in your
// real values there. games.config.js is gitignored and never committed;
// this example file is what's safe to keep in the public/shared repo.
// -----------------------------------------------------------------------

// The one coordinator every game shares (a single global host lock).
// statusBinding must match the [[services]] binding in wrangler.toml.
export const COORDINATOR = {
  statusUrl: "https://moonberry-coordinator.your-subdomain.workers.dev/status",
  statusSecret: "REPLACE_WITH_YOUR_COORDINATOR_SHARED_SECRET",
  statusBinding: "COORDINATOR",
};

// One entry per game, keyed by the game_id the companion app sends.
//   recommendedPassword  optional; shown only if the app didn't send one
//                        with the notification. Leave out for no line.
//   noCodeText           line shown when there's no join code; "" or
//                        null leaves it out.
//   statusUrl / statusSecret / statusBinding  optional per-game override
//                        of COORDINATOR (only if a game gets its own).
export const GAMES = {
  valheim: {
    displayName: "Valheim",
    emoji: "🌙",
    channelId: "REPLACE_WITH_YOUR_DISCORD_CHANNEL_ID",
    recommendedPassword: "REPLACE_WITH_YOUR_GROUP_PASSWORD",
    noCodeText: "Join via Steam invite (no join code found this session)",
  },
  dragonwilds: {
    displayName: "RuneScape: Dragonwilds",
    emoji: "🐉",
    channelId: "REPLACE_WITH_YOUR_DISCORD_CHANNEL_ID",
    noCodeText: "No invite code shared yet — ask the host for it.",
  },
  zomboid: {
    displayName: "Project Zomboid",
    emoji: "🧟",
    channelId: "REPLACE_WITH_YOUR_DISCORD_CHANNEL_ID",
    noCodeText: "Join via the host's Steam invite.",
  },
};
