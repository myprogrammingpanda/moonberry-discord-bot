/**
 * Moonberry
 * --------
 * A generic Discord bot for game-hosting notifications, built to support
 * more than one game later without restructuring anything.
 *
 * How it works:
 *   1. The companion app (moonberry-save-sync) calls POST /notify with
 *      the game_id in the body whenever someone starts or stops hosting.
 *      This Worker then posts a message to that game's Discord channel.
 *   2. Discord sends slash-command invocations (e.g. /status) to
 *      POST /interactions. This Worker verifies the request really came
 *      from Discord, then replies with live status pulled directly from
 *      the coordinator.
 *
 * All games share ONE coordinator (one host per game at a time), set once
 * as COORDINATOR in games.config.js. A game entry can still override
 * statusUrl/statusSecret/statusBinding if it ever gets its own.
 *
 * ADDING A NEW GAME LATER: add one entry to GAMES in games.config.js,
 * then re-register the slash commands (npm run commands:register) so the
 * new game shows up in the /status and /set-channel choices. Nothing in
 * this file needs to change.
 *
 * NOTE: signature verification uses the "discord-interactions" npm
 * package rather than hand-rolled WebCrypto Ed25519 calls -- this is
 * the approach basically every working Cloudflare Workers Discord bot
 * example uses, since it's a well-tested implementation rather than
 * something built from scratch. Run `npm install` in this folder
 * before deploying (see SETUP.md).
 */

import { verifyKey } from "discord-interactions";
// Namespace import so an older games.config.js without a COORDINATOR
// export still builds (it just comes through as undefined).
import * as config from "./games.config.js";

// ---------------------------------------------------------------------
// Game registry lives in games.config.js (gitignored, not committed).
// See games.config.example.js for the template.
// ---------------------------------------------------------------------

const GAMES = config.GAMES;
const COORDINATOR = config.COORDINATOR || {};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------
// Discord REST helpers
// ---------------------------------------------------------------------

async function postDiscordMessage(env, channelId, content) {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    // allowed_mentions: host names and join codes come from the companion
    // app, so never let them ping @everyone/@here, roles or users.
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API error ${res.status}: ${text}`);
  }
  return res.json();
}

// A game's own coordinator settings win; otherwise the shared COORDINATOR.
function coordinatorFor(game) {
  return {
    statusUrl: game?.statusUrl || COORDINATOR.statusUrl,
    statusSecret: game?.statusSecret || COORDINATOR.statusSecret,
    statusBinding: game?.statusBinding || COORDINATOR.statusBinding,
  };
}

async function fetchCoordinatorStatus(coordinator, env) {
  const headers = {
    "X-Auth": coordinator.statusSecret,
    "User-Agent": "Moonberry-Bot/1.0",
  };

  let res;
  if (coordinator.statusBinding && env[coordinator.statusBinding]) {
    // Preferred path: direct Worker-to-Worker call via Service Binding,
    // bypassing the public internet entirely (and Cloudflare's 1042
    // loop-prevention block on Worker-to-workers.dev fetches).
    res = await env[coordinator.statusBinding].fetch(coordinator.statusUrl, { headers });
  } else {
    // Fallback for a future game whose coordinator ISN'T a Cloudflare
    // Worker on this account (e.g. hosted elsewhere) -- ordinary public
    // fetch works fine in that case, since the 1042 restriction only
    // applies to Worker-to-Worker calls on workers.dev.
    res = await fetch(coordinator.statusUrl, { headers });
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "(no body)");
    throw new Error(`Status fetch failed: ${res.status} - ${bodyText}`);
  }
  return res.json();
}


// ---------------------------------------------------------------------
// Discord Interactions signature verification (required by Discord --
// this proves a request claiming to be from Discord actually is)
// ---------------------------------------------------------------------

async function verifyDiscordRequest(request, publicKeyHex, body) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return false;

  return verifyKey(body, signature, timestamp, publicKeyHex);
}

// ---------------------------------------------------------------------
// Slash command handling
// ---------------------------------------------------------------------

const CHANNEL_KV_PREFIX = "channel:";

async function getChannelForGame(env, gameKey, fallbackChannelId) {
  const stored = await env.MOONBERRY_KV.get(CHANNEL_KV_PREFIX + gameKey);
  return stored || fallbackChannelId;
}

async function setChannelForGame(env, gameKey, channelId) {
  await env.MOONBERRY_KV.put(CHANNEL_KV_PREFIX + gameKey, channelId);
}

function displayNameFor(gameKey) {
  return GAMES[gameKey]?.displayName || gameKey;
}

async function handleStatusCommand(interaction, env) {
  const gameOption = interaction.data.options?.find((o) => o.name === "game");
  const gameKey = gameOption ? gameOption.value : null;
  const game = gameKey ? GAMES[gameKey] : null;

  if (gameKey && !game) {
    return { content: `Unknown game "${gameKey}".` };
  }

  let status;
  try {
    status = await fetchCoordinatorStatus(coordinatorFor(game), env);
  } catch (e) {
    const what = game ? `the ${game.displayName} coordinator` : "the coordinator";
    return { content: `⚠️ Couldn't reach ${what} right now.` };
  }

  const hosts = hostsByGame(status);
  const hostingLine = (key) => {
    const g = GAMES[key];
    const emoji = g ? `${g.emoji} ` : "";
    const host = hosts[key];
    const codePart = host.join_code ? ` | Join Code: **${host.join_code}**` : "";
    return `${emoji}**${displayNameFor(key)}**: ${host.host_name} is currently hosting${codePart}`;
  };

  if (!game) {
    // No game picked: every game being hosted right now, if any.
    const keys = Object.keys(hosts).sort();
    return { content: keys.length ? keys.map(hostingLine).join("\n") : "Nobody is hosting anything right now." };
  }

  if (hosts[gameKey]) {
    return { content: hostingLine(gameKey) };
  }

  return {
    content: `${game.emoji} **${game.displayName}**: nobody is hosting right now.`,
  };
}

// { game_id: { host_name, join_code, ... } } for every game being hosted.
// The coordinator allows one host per game and lists them in `hosts`; an
// older one only knew one global host, in the top-level fields (and keeps
// the last game_id after a session ends, so `hosting` has to be checked).
function hostsByGame(status) {
  if (status.hosts && typeof status.hosts === "object") return status.hosts;
  if (!status.hosting) return {};
  return { [status.game_id || "unknown"]: { host_name: status.host_name, join_code: status.join_code } };
}

async function handleSetChannelCommand(interaction, env) {
  const gameOption = interaction.data.options?.find((o) => o.name === "game");
  const gameKey = gameOption ? gameOption.value : Object.keys(GAMES)[0];
  const game = GAMES[gameKey];

  if (!game) {
    return { content: `Unknown game "${gameKey}".` };
  }

  // The channel this command was typed in becomes the new notification
  // target -- no need to paste a channel ID manually.
  const channelId = interaction.channel_id;
  await setChannelForGame(env, gameKey, channelId);

  return {
    content: `${game.emoji} Got it — ${game.displayName} hosting notifications will now be posted in this channel.`,
  };
}

// Optional string fields from the companion app: trimmed, length-capped,
// and null when missing/blank or not a string.
function cleanField(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed || null;
}

// ---------------------------------------------------------------------
// Shared notify logic (called by both the current /notify and the
// legacy /notify/<game> routes)
// ---------------------------------------------------------------------

async function handleNotify(gameKey, body, env) {
  const game = GAMES[gameKey];
  if (!game) {
    return json({ error: "unknown_game" }, 404);
  }

  const hostName = cleanField(body.host_name, 64) || "Someone";
  const joinCode = cleanField(body.join_code, 64);
  const event = body.event || "started"; // "started" or "ended"

  let message;
  if (event === "ended") {
    message = `${game.emoji} **${hostName}** stopped hosting ${game.displayName}. World save synced to the cloud.`;
  } else {
    // Password: the host's per-game setting from the app if it sent one,
    // else this game's recommendedPassword, else no password line at all.
    const password = cleanField(body.password, 128) || game.recommendedPassword || null;

    // No join code: the game's own fallback line (noCodeText); an empty
    // string or null leaves the line out.
    const codeLine = joinCode
      ? `Join Code: **${joinCode}**`
      : game.noCodeText === undefined
        ? "No join code shared yet — ask the host."
        : game.noCodeText;

    const lines = [`${game.emoji} **${hostName}** just started hosting ${game.displayName}!`];
    // Backticks would end the inline-code span early, so strip them.
    if (password) lines.push(`Password: \`${password.replace(/`/g, "")}\``);
    if (codeLine) lines.push(codeLine);
    message = lines.join("\n");
  }

  try {
    const targetChannelId = await getChannelForGame(env, gameKey, game.channelId);
    await postDiscordMessage(env, targetChannelId, message);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// ---------------------------------------------------------------------
// Main request router
// ---------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- Discord Interactions endpoint (slash commands) ---
    if (request.method === "POST" && url.pathname === "/interactions") {
      const bodyText = await request.text();
      const valid = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY, bodyText);
      if (!valid) {
        return new Response("Invalid request signature", { status: 401 });
      }

      const interaction = JSON.parse(bodyText);

      // Discord's handshake ping -- must reply with type 1
      if (interaction.type === 1) {
        return json({ type: 1 });
      }

      // Slash command invocation
      if (interaction.type === 2 && interaction.data.name === "status") {
        const reply = await handleStatusCommand(interaction, env);
        return json({ type: 4, data: reply });
      }

      if (interaction.type === 2 && interaction.data.name === "set-channel") {
        const reply = await handleSetChannelCommand(interaction, env);
        return json({ type: 4, data: reply });
      }

      return json({ type: 4, data: { content: "Unknown command." } });
    }

    // --- POST /notify -- generic endpoint, game_id in the body. Used by
    //     the current companion apps (one endpoint, any number of games). ---
    if (request.method === "POST" && url.pathname === "/notify") {
      const auth = request.headers.get("X-Auth");
      if (!auth || auth !== env.NOTIFY_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }

      const body = await request.json().catch(() => ({}));
      if (!body.game_id) {
        return json({ error: "missing_game_id" }, 400);
      }

      return handleNotify(body.game_id, body, env);
    }

    // --- POST /notify/<game> -- legacy path-based endpoint, kept for
    //     older companion apps that predate the game_id-in-body contract.
    //     Remove once every game's app has upgraded to POST /notify. ---
    if (request.method === "POST" && url.pathname.startsWith("/notify/")) {
      const gameKey = url.pathname.split("/notify/")[1];

      const auth = request.headers.get("X-Auth");
      if (!auth || auth !== env.NOTIFY_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }

      const body = await request.json().catch(() => ({}));
      return handleNotify(gameKey, body, env);
    }

    return json({ error: "not_found" }, 404);
  },
};
