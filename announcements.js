/**
 * Coordinator-driven hosting announcements
 * ----------------------------------------
 * A Cron Trigger (every minute) calls runAnnouncementTick(), which reads
 * the coordinator's /status, compares it with what it saw last time and
 * posts "X just started/stopped hosting" itself -- so a player no longer
 * needs the bot URL + secret in their app for their sessions to be
 * announced.
 *
 * Everything lives in MOONBERRY_KV, which allows only 1,000 writes a day
 * on the free tier, so a tick only writes when it actually posted
 * something (or noticed the app did). Holding a "started" post while a
 * join code is on its way needs no writes: the wait is measured from the
 * coordinator's own `since`.
 *
 *   announce:settings   { enabled, since, games: { <game>: { enabled, since } } }
 *                       set by /announcements. `since` = when it was turned
 *                       on; sessions that were already running then are
 *                       never announced (no surprise backlog).
 *   announce:state      { hosts: { <game>: { host_name, since, by } },
 *                         stopped: { <game>: { host_name, at } } }
 *                       hosts = sessions whose start was announced, by
 *                       "bot" (this file) or "app" (an app's POST /notify).
 *   notify:<game>       { started: { host_name, at }, ended: { host_name, at } }
 *                       the last POST /notify per event, so the cron can skip
 *                       what an older app already posted (and vice versa).
 *
 * Kept free of games.config.js and Discord details (they're passed in) so
 * it can be tested on its own -- see scripts/test-announcements.mjs.
 */

const SETTINGS_KEY = "announce:settings";
const STATE_KEY = "announce:state";
const NOTIFY_KEY_PREFIX = "notify:";

// How far a /notify may precede the coordinator's `since` and still count
// as the same session (clock differences between the two Workers).
const CLOCK_SLACK_MS = 60 * 1000;
// How long after the cron posted a "stopped" an app's own "ended" for the
// same host is treated as a duplicate.
const RECENT_STOP_MS = 15 * 60 * 1000;

// { game_id: { host_name, join_code, since, ... } } for every game being
// hosted. The coordinator allows one host per game and lists them in
// `hosts`; an older one only knew one global host, in the top-level fields
// (and keeps the last game_id after a session ends, so `hosting` has to be
// checked).
export function hostsByGame(status) {
  if (status.hosts && typeof status.hosts === "object") return status.hosts;
  if (!status.hosting) return {};
  return {
    [status.game_id || "unknown"]: {
      host_name: status.host_name,
      join_code: status.join_code,
      since: status.since,
    },
  };
}

// ---------------------------------------------------------------------
// Messages (shared with POST /notify)
// ---------------------------------------------------------------------

// Each builder returns a Discord message object ({ content, ... }) rather
// than a bare string, so extras like a button (`components`) can be added
// here without touching the callers.

export function startedMessage(game, { hostName, joinCode, password }) {
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
  return { content: lines.join("\n") };
}

export function stoppedMessage(game, { hostName }) {
  return { content: `${game.emoji} **${hostName}** stopped hosting ${game.displayName}. World save synced to the cloud.` };
}

// ---------------------------------------------------------------------
// Settings (/announcements)
// ---------------------------------------------------------------------

export async function getSettings(kv) {
  return (await kv.get(SETTINGS_KEY, "json")) || { enabled: false, since: null, games: {} };
}

// The game's own on/off if one was set, else the global one.
export function effectiveSetting(settings, gameKey) {
  const own = settings.games?.[gameKey];
  return own ? own : { enabled: !!settings.enabled, since: settings.since };
}

// Turns announcements on/off for one game, or (gameKey null) for every
// game, dropping the per-game overrides. Also forgets the affected games'
// tracked sessions, so a session that ended while announcements were off
// doesn't get a late "stopped" post once they're back on.
export async function setAnnouncements(kv, gameKey, enabled, now = Date.now()) {
  const settings = await getSettings(kv);
  const entry = { enabled, since: enabled ? now : null };
  const next = gameKey
    ? { ...settings, games: { ...settings.games, [gameKey]: entry } }
    : { ...entry, games: {} };
  await kv.put(SETTINGS_KEY, JSON.stringify(next));

  const state = await getState(kv);
  const hosts = { ...state.hosts };
  for (const key of Object.keys(hosts)) {
    if (!gameKey || key === gameKey) delete hosts[key];
  }
  if (Object.keys(hosts).length !== Object.keys(state.hosts).length) {
    await kv.put(STATE_KEY, JSON.stringify({ ...state, hosts }));
  }
  return next;
}

// ---------------------------------------------------------------------
// Dedupe with apps that still POST /notify themselves
// ---------------------------------------------------------------------

async function getState(kv) {
  const state = (await kv.get(STATE_KEY, "json")) || {};
  return { hosts: state.hosts || {}, stopped: state.stopped || {} };
}

// Called by POST /notify before it posts. Records the notification (only
// while the cron is announcing this game -- otherwise nothing reads it,
// and KV writes are scarce) and says whether the cron already posted it.
export async function noteAppNotify(kv, gameKey, event, hostName, now = Date.now()) {
  const settings = await getSettings(kv);
  if (!effectiveSetting(settings, gameKey).enabled) return { duplicate: false };

  const key = NOTIFY_KEY_PREFIX + gameKey;
  const record = (await kv.get(key, "json")) || {};
  await kv.put(key, JSON.stringify({ ...record, [event]: { host_name: hostName, at: now } }));

  const state = await getState(kv);
  if (event === "ended") {
    const stop = state.stopped[gameKey];
    return { duplicate: !!stop && stop.host_name === hostName && now - stop.at < RECENT_STOP_MS };
  }
  const host = state.hosts[gameKey];
  return { duplicate: !!host && host.by === "bot" && host.host_name === hostName };
}

const hostNameOf = (host) => host.host_name || "Someone";
const sinceOf = (host) => (typeof host.since === "number" ? host.since : null);

// Did an app's POST /notify already announce this event for this session?
function appAnnounced(record, event, hostName, sessionSince) {
  const r = record?.[event];
  if (!r || r.host_name !== hostName) return false;
  return sessionSince == null || r.at >= sessionSince - CLOCK_SLACK_MS;
}

// ---------------------------------------------------------------------
// The cron tick
// ---------------------------------------------------------------------

/**
 * One pass: post whatever changed since the last pass.
 *   kv           MOONBERRY_KV
 *   games        GAMES from games.config.js
 *   fetchStatus  () => coordinator /status JSON (throws on failure)
 *   post         (gameKey, message) => posts to that game's channel (throws on failure)
 * Returns a short summary (for logs/tests).
 */
export async function runAnnouncementTick({ kv, games, fetchStatus, post, now = Date.now() }) {
  const settings = await getSettings(kv);
  const enabled = (key) => !!games[key] && effectiveSetting(settings, key).enabled;
  if (!Object.keys(games).some(enabled)) return { skipped: "off" };

  // A failed fetch must never look like "everyone stopped hosting".
  const live = hostsByGame(await fetchStatus());
  const state = await getState(kv);
  const posted = [];
  const failed = [];
  let changed = false;

  // One game's failing post (e.g. a deleted channel) mustn't hold up the
  // others; it's simply retried next minute.
  const tryPost = async (key, event, message) => {
    try {
      await post(key, message);
      posted.push(`${key}:${event}`);
      return true;
    } catch (e) {
      failed.push(`${key}:${event}: ${e.message}`);
      return false;
    }
  };

  const notifyRecords = {};
  const notifyRecord = async (key) => {
    if (!(key in notifyRecords)) notifyRecords[key] = await kv.get(NOTIFY_KEY_PREFIX + key, "json");
    return notifyRecords[key];
  };

  // Sessions announced earlier that have ended (or been replaced by
  // another host of the same game).
  for (const [key, tracked] of Object.entries(state.hosts)) {
    const cur = live[key];
    if (cur && hostNameOf(cur) === tracked.host_name && sinceOf(cur) === (tracked.since ?? null)) continue;

    if (enabled(key) && !appAnnounced(await notifyRecord(key), "ended", tracked.host_name, tracked.since)) {
      // Before touching state, so a failed post is retried next minute.
      if (!(await tryPost(key, "stopped", stoppedMessage(games[key], { hostName: tracked.host_name })))) continue;
      state.stopped[key] = { host_name: tracked.host_name, at: now };
    }
    delete state.hosts[key];
    changed = true;
  }

  // New sessions.
  for (const [key, cur] of Object.entries(live)) {
    if (state.hosts[key] || !enabled(key)) continue;
    const game = games[key];
    const since = sinceOf(cur);
    const hostName = hostNameOf(cur);

    // Already running when announcements were switched on.
    const onSince = effectiveSetting(settings, key).since;
    if (since != null && onSince != null && since < onSince) continue;

    if (appAnnounced(await notifyRecord(key), "started", hostName, since)) {
      state.hosts[key] = { host_name: hostName, since, by: "app" };
      changed = true;
      continue;
    }

    // Hold the post while this game's join code is probably on its way.
    const waitMs = (game.joinCodeWaitSeconds || 0) * 1000;
    if (!cur.join_code && since != null && now - since < waitMs) continue;

    const message = startedMessage(game, {
      hostName,
      joinCode: cur.join_code || null,
      // Same as POST /notify without a password: the game's default.
      password: game.recommendedPassword || null,
    });
    if (!(await tryPost(key, "started", message))) continue;
    state.hosts[key] = { host_name: hostName, since, by: "bot" };
    changed = true;
  }

  if (changed) await kv.put(STATE_KEY, JSON.stringify(state));
  return { posted, failed, changed };
}
