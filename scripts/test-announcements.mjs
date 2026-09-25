// scripts/test-announcements.mjs
// -----------------------------------------------------------------------
// Tests for announcements.js with a fake KV, coordinator and Discord --
// no network, no games.config.js needed.
//
//   npm test
// -----------------------------------------------------------------------

import assert from "node:assert/strict";
import {
  runAnnouncementTick,
  setAnnouncements,
  noteAppNotify,
  hostsByGame,
  startedMessage,
} from "../announcements.js";

const GAMES = {
  valheim: { displayName: "Valheim", emoji: "🪓", recommendedPassword: "pw", noCodeText: "Steam invite", joinCodeWaitSeconds: 300 },
  dragonwilds: { displayName: "Dragonwilds", emoji: "🐉", noCodeText: "No code yet", joinCodeWaitSeconds: 660 },
  zomboid: { displayName: "Zomboid", emoji: "🧟", noCodeText: "Steam invite" },
};

const S = 1000;
const T0 = 1_800_000_000_000;

function fakeKv() {
  const data = new Map();
  const kv = {
    writes: 0,
    async get(key, type) {
      const v = data.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      kv.writes++;
      data.set(key, value);
    },
  };
  return kv;
}

// A world where `status` is what the coordinator returns and `posts`
// collects what would have gone to Discord.
function world() {
  const w = { kv: fakeKv(), hosts: {}, posts: [], fetches: 0, failPost: null, failFetch: false };
  w.tick = (now) =>
    runAnnouncementTick({
      kv: w.kv,
      games: GAMES,
      now,
      fetchStatus: async () => {
        w.fetches++;
        if (w.failFetch) throw new Error("coordinator down");
        return { hosts: structuredClone(w.hosts) };
      },
      post: async (game, message) => {
        if (w.failPost === game) throw new Error("Discord API error 404");
        w.posts.push(`${game}: ${message.content}`);
      },
    });
  w.take = () => w.posts.splice(0);
  return w;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("off by default: no coordinator fetch, no posts, no writes", async () => {
  const w = world();
  w.hosts.zomboid = { host_name: "Ann", since: T0 };
  assert.deepEqual(await w.tick(T0 + 60 * S), { skipped: "off" });
  assert.equal(w.fetches, 0);
  assert.equal(w.kv.writes, 0);
});

test("game without join codes is announced at once; stop is announced", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + 5 * S, join_code: null };
  await w.tick(T0 + 60 * S);
  assert.deepEqual(w.take(), ["zomboid: 🧟 **Ann** just started hosting Zomboid!\nSteam invite"]);

  const writes = w.kv.writes;
  await w.tick(T0 + 120 * S);
  await w.tick(T0 + 180 * S);
  assert.deepEqual(w.take(), []);
  assert.equal(w.kv.writes, writes, "unchanged ticks must not write to KV");

  delete w.hosts.zomboid;
  await w.tick(T0 + 240 * S);
  assert.deepEqual(w.take(), ["zomboid: 🧟 **Ann** stopped hosting Zomboid. World save synced to the cloud."]);
});

test("join-code game is held until the code shows up, with no writes meanwhile", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.valheim = { host_name: "Bo", since: T0 + 10 * S, join_code: null };
  const writes = w.kv.writes;
  await w.tick(T0 + 60 * S);
  await w.tick(T0 + 120 * S);
  assert.deepEqual(w.take(), []);
  assert.equal(w.kv.writes, writes);

  w.hosts.valheim.join_code = "ABC123";
  await w.tick(T0 + 180 * S);
  assert.deepEqual(w.take(), ["valheim: 🪓 **Bo** just started hosting Valheim!\nPassword: `pw`\nJoin Code: **ABC123**"]);
});

test("join-code game posts without a code once the wait runs out", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.dragonwilds = { host_name: "Cy", since: T0, join_code: null };
  await w.tick(T0 + 659 * S);
  assert.deepEqual(w.take(), []);
  await w.tick(T0 + 660 * S);
  assert.deepEqual(w.take(), ["dragonwilds: 🐉 **Cy** just started hosting Dragonwilds!\nNo code yet"]);
});

test("a session ending while still held is never announced", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.valheim = { host_name: "Bo", since: T0, join_code: null };
  await w.tick(T0 + 60 * S);
  delete w.hosts.valheim;
  await w.tick(T0 + 120 * S);
  assert.deepEqual(w.take(), []);
});

test("sessions already running when turned on are skipped (start and stop)", async () => {
  const w = world();
  w.hosts.zomboid = { host_name: "Ann", since: T0 - 100 * S };
  await setAnnouncements(w.kv, null, true, T0);
  await w.tick(T0 + 60 * S);
  delete w.hosts.zomboid;
  await w.tick(T0 + 120 * S);
  assert.deepEqual(w.take(), []);
});

test("host replaced within one tick: stop for the old, start for the new", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + S };
  await w.tick(T0 + 60 * S);
  w.take();
  w.hosts.zomboid = { host_name: "Dee", since: T0 + 90 * S };
  await w.tick(T0 + 120 * S);
  assert.deepEqual(w.take(), [
    "zomboid: 🧟 **Ann** stopped hosting Zomboid. World save synced to the cloud.",
    "zomboid: 🧟 **Dee** just started hosting Zomboid!\nSteam invite",
  ]);
});

test("same host reclaiming (new since) counts as a new session", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + S };
  await w.tick(T0 + 60 * S);
  w.take();
  w.hosts.zomboid = { host_name: "Ann", since: T0 + 90 * S };
  await w.tick(T0 + 120 * S);
  assert.equal(w.take().length, 2);
});

test("old app posted first: cron skips its start and stop", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.valheim = { host_name: "Bo", since: T0 + 10 * S, join_code: "XYZ" };
  assert.deepEqual(await noteAppNotify(w.kv, "valheim", "started", "Bo", T0 + 30 * S), { duplicate: false });
  await w.tick(T0 + 60 * S);
  assert.deepEqual(w.take(), []);

  delete w.hosts.valheim;
  assert.deepEqual(await noteAppNotify(w.kv, "valheim", "ended", "Bo", T0 + 500 * S), { duplicate: false });
  await w.tick(T0 + 540 * S);
  assert.deepEqual(w.take(), []);
});

test("old app announced the start but never the stop: cron posts the stop", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + 10 * S };
  await noteAppNotify(w.kv, "zomboid", "started", "Ann", T0 + 11 * S);
  await w.tick(T0 + 60 * S);
  delete w.hosts.zomboid;
  await w.tick(T0 + 120 * S);
  assert.deepEqual(w.take(), ["zomboid: 🧟 **Ann** stopped hosting Zomboid. World save synced to the cloud."]);
});

test("an app's /notify from an earlier session doesn't suppress a new one", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  await noteAppNotify(w.kv, "zomboid", "started", "Ann", T0 + 10 * S);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + 3600 * S };
  await w.tick(T0 + 3660 * S);
  assert.equal(w.take().length, 1);
});

test("cron posted first: the app's /notify is reported as a duplicate", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + 10 * S };
  await w.tick(T0 + 60 * S);
  assert.deepEqual(await noteAppNotify(w.kv, "zomboid", "started", "Ann", T0 + 61 * S), { duplicate: true });
  assert.deepEqual(await noteAppNotify(w.kv, "zomboid", "started", "Someone else", T0 + 61 * S), { duplicate: false });

  delete w.hosts.zomboid;
  await w.tick(T0 + 120 * S);
  assert.deepEqual(await noteAppNotify(w.kv, "zomboid", "ended", "Ann", T0 + 121 * S), { duplicate: true });
  assert.deepEqual(await noteAppNotify(w.kv, "zomboid", "ended", "Ann", T0 + 3600 * S), { duplicate: false });
});

test("/notify writes nothing while announcements are off", async () => {
  const w = world();
  assert.deepEqual(await noteAppNotify(w.kv, "zomboid", "started", "Ann", T0), { duplicate: false });
  assert.equal(w.kv.writes, 0);
});

test("coordinator failure changes nothing (no false 'stopped')", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + S };
  await w.tick(T0 + 60 * S);
  w.take();
  w.failFetch = true;
  await assert.rejects(w.tick(T0 + 120 * S));
  w.failFetch = false;
  await w.tick(T0 + 180 * S);
  assert.deepEqual(w.take(), []);
});

test("a failing channel doesn't block other games, and is retried", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + S };
  w.hosts.valheim = { host_name: "Bo", since: T0 + S, join_code: "C0DE" };
  w.failPost = "zomboid";
  const r = await w.tick(T0 + 60 * S);
  assert.equal(r.failed.length, 1);
  assert.equal(w.take().length, 1);
  w.failPost = null;
  await w.tick(T0 + 120 * S);
  assert.deepEqual(w.take(), ["zomboid: 🧟 **Ann** just started hosting Zomboid!\nSteam invite"]);
});

test("per-game off: that game is silent, others still announced", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  await setAnnouncements(w.kv, "zomboid", false, T0);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + S };
  w.hosts.valheim = { host_name: "Bo", since: T0 + S, join_code: "C0DE" };
  await w.tick(T0 + 60 * S);
  assert.deepEqual(w.take().map((p) => p.split(":")[0]), ["valheim"]);
});

test("only one game on (global off) still runs the tick for that game", async () => {
  const w = world();
  await setAnnouncements(w.kv, "zomboid", true, T0);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + S };
  w.hosts.valheim = { host_name: "Bo", since: T0 + S, join_code: "C0DE" };
  await w.tick(T0 + 60 * S);
  assert.deepEqual(w.take().map((p) => p.split(":")[0]), ["zomboid"]);
});

test("turning off then on doesn't post a late stop for a session that ended meanwhile", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.zomboid = { host_name: "Ann", since: T0 + S };
  await w.tick(T0 + 60 * S);
  w.take();
  await setAnnouncements(w.kv, null, false, T0 + 70 * S);
  delete w.hosts.zomboid;
  await w.tick(T0 + 120 * S);
  await setAnnouncements(w.kv, null, true, T0 + 130 * S);
  await w.tick(T0 + 180 * S);
  assert.deepEqual(w.take(), []);
});

test("unknown games in the coordinator are ignored", async () => {
  const w = world();
  await setAnnouncements(w.kv, null, true, T0);
  w.hosts.minecraft = { host_name: "Ann", since: T0 + S };
  await w.tick(T0 + 60 * S);
  assert.deepEqual(w.take(), []);
});

test("older coordinator (top-level fields only) is understood", () => {
  assert.deepEqual(hostsByGame({ hosting: false, game_id: "valheim" }), {});
  assert.deepEqual(hostsByGame({ hosting: true, game_id: "valheim", host_name: "Bo", join_code: "X", since: 5 }), {
    valheim: { host_name: "Bo", join_code: "X", since: 5 },
  });
});

test("message builder: backticks stripped from password, noCodeText '' drops the line", () => {
  const game = { displayName: "G", emoji: "🎮", noCodeText: "" };
  assert.equal(startedMessage(game, { hostName: "A", password: "a`b" }).content, "🎮 **A** just started hosting G!\nPassword: `ab`");
  assert.equal(startedMessage({ displayName: "G", emoji: "🎮" }, { hostName: "A" }).content,
    "🎮 **A** just started hosting G!\nNo join code shared yet — ask the host.");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message.split("\n").join("\n      ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
