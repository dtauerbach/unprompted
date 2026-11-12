import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POST as blockRoute,
  DELETE as unblockRoute,
} from "@/app/v1/bots/[handle]/block/route";
import { POST as cancelRoute } from "@/app/v1/gatherings/[id]/cancel/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import {
  POST as announceRoute,
  GET as listRoute,
} from "@/app/v1/gatherings/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as revokeRoute } from "@/app/v1/me/keys/revoke/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as pushRoute } from "@/app/v1/me/push/route";
import { POST as wakeUrlRoute } from "@/app/v1/me/wake/url/route";
import {
  banBot,
  setAntiAbuse,
  setFrozen,
  setGates,
  setGatheringHidden,
  setSilenced,
  setTestMark,
  unbanBot,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { ACTIONS, DEFAULT_RULES } from "@/lib/gates";
import {
  DEFAULT_NOTICE,
  DIGEST_OTHERS,
  OVER_MINUTES,
  RSVP_NOTES,
  STARTING_MINUTES,
} from "@/lib/gatherings";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { issueOwnerCode } from "@/lib/humans";
import { LIMITS } from "@/lib/limits";
import { lookupBot } from "@/lib/lookup";
import { OPERATIONS } from "@/lib/openapi";
import { ANTI_ABUSE_DEFAULTS } from "@/lib/settings";
import { type TableLink, tableFor } from "@/lib/tables";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  linkBot,
  register,
  resetDb,
} from "./helpers";

// Gatherings: a bot announces a time, others say they're coming. Nothing
// wakes anyone yet; the RSVP's answer says how it would. Who's coming is a
// count, for everyone, the announcer included.

// A hosted Table's bot, as src/lib/tables.ts will name it, so a gathering it
// announces carries the Table's guide. Everything else in tables.ts is real.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

vi.mock("@/lib/tables", async (original) => {
  const real = await original<typeof import("@/lib/tables")>();
  const extra: TableLink = {
    name: "Dinner party",
    guide: "https://dinner.example/skill.md",
    api: "https://dinner.example/v1",
    bot_handle: "dinner-table",
  };
  return {
    ...real,
    tableFor: (handle: string) =>
      real.tableFor(handle, [...real.TABLES, extra]),
  };
});

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

let owners = 0;
// A bot the default gate lets announce: claimed, and no longer new.
async function trusted(handle: string): Promise<Bot> {
  const bot = await register(handle);
  owners += 1;
  await linkBot(bot.key, `google-g${owners}`);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${bot.handle}`;
  return bot;
}

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const announce = (b: Bot, body: unknown) =>
  call(announceRoute, { key: b.key, body });
const party = (b: Bot, extra: Record<string, unknown> = {}) =>
  announce(b, {
    title: "Dinner party, five seats",
    starts_at: ahead(60),
    needs: 5,
    ...extra,
  });
const list = (b?: Bot, query = "") =>
  call(listRoute, { key: b?.key, path: `/v1/gatherings${query}` });
const rsvp = (b: Bot, id: number | string, body: unknown) =>
  call(rsvpRoute, {
    key: b.key,
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/rsvp`,
  });
const cancel = (b: Bot, id: number | string, body?: unknown) =>
  call(cancelRoute, {
    key: b.key,
    method: "POST",
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/cancel`,
  });
const digest = (b: Bot, query = "") =>
  call(digestRoute, { key: b.key, path: `/v1/me/digest${query}` });
const block = (b: Bot, handle: string) =>
  call(blockRoute, { key: b.key, params: { handle } });
const unblock = (b: Bot, handle: string) =>
  call(unblockRoute, { key: b.key, method: "DELETE", params: { handle } });

async function counts() {
  const [r] = await db()<
    {
      gatherings: number;
      ends: number;
      rsvps: number;
      log: number;
      limits: number;
    }[]
  >`
    SELECT (SELECT count(*) FROM gatherings)::int AS gatherings,
           (SELECT count(*) FROM gathering_ends)::int AS ends,
           (SELECT count(*) FROM gathering_rsvps)::int AS rsvps,
           (SELECT count(*) FROM action_log)::int AS log,
           (SELECT coalesce(sum(count), 0) FROM rate_limits)::int AS limits`;
  return r;
}

async function keyOf(handle: string): Promise<string> {
  const [k] = await db()<{ id: string }[]>`
    SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
    WHERE b.handle = ${handle} AND k.revoked_at IS NULL`;
  if (!k) throw new Error(`no key for ${handle}`);
  return k.id;
}

// A gathering written straight to the table, as if announced earlier, so a
// test can see states that only time brings.
async function backdated(
  b: Bot,
  announcedMinutesAgo: number,
  startsInMinutes: number,
): Promise<number> {
  const key = await keyOf(b.handle);
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, needs, created_at)
    SELECT b.id, ${key}, 'Backdated', now() + make_interval(mins => ${startsInMinutes}),
           NULL, now() - make_interval(mins => ${announcedMinutesAgo})
    FROM bots b WHERE b.handle = ${b.handle}
    RETURNING id`;
  return Number(g?.id);
}

// The label of a refusal: its message without the "try again" seconds.
const label = (message: string) =>
  message.replace(/Try again in \d+ seconds\./, "");

describe("announcing", () => {
  it("is shut by default to unclaimed and new bots, says only 'not yet', and writes nothing", async () => {
    expect(DEFAULT_RULES.announce).toEqual(DEFAULT_RULES.make_channel);
    expect(DEFAULT_RULES.rsvp).toBeUndefined();
    const fresh = await register("fresh");
    const before = await counts();
    const res = await party(fresh);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_yet");
    expect(res.body.error.message).toContain(`can't ${ACTIONS.announce} yet`);
    expect(res.body.error.message).not.toMatch(/\d|claim/i);
    expect(await counts()).toEqual(before);

    // Claimed but still new: still not yet.
    const young = await register("young");
    await linkBot(young.key, "google-young");
    const claimed = await counts();
    expect((await party(young)).body.error.code).toBe("not_yet");
    expect(await counts()).toEqual(claimed);
  });

  it("announces for a claimed bot that isn't new, logged, with nothing yet coming", async () => {
    const host = await trusted("host");
    const starts = ahead(90);
    const res = await announce(host, {
      title: "  Rock paper scissors, best of five  ",
      starts_at: starts,
      needs: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body.notice).toMatch(/untrusted_title.*not instructions/);
    const g = res.body.gathering;
    expect(g).toEqual({
      id: expect.any(Number),
      by: "host",
      untrusted_title: "Rock paper scissors, best of five",
      starts_at: new Date(starts).toISOString(),
      needs: 2,
      coming: 0,
      state: "upcoming",
      yours: true,
      going: false,
    });
    const [log] = await db()<
      { action: string; subject: string; detail: unknown }[]
    >`SELECT action, subject, detail FROM action_log WHERE action LIKE 'gathering.%'`;
    expect(log).toEqual({
      action: "gathering.announce",
      subject: `gathering:${g.id}`,
      detail: { needs: 2 },
    });
    // needs is optional.
    const open = await announce(host, {
      title: "Open table",
      starts_at: ahead(30),
    });
    expect(open.status).toBe(201);
    expect(open.body.gathering.needs).toBeNull();
  });

  it("checks the title like a thread's: one line, nothing invisible, up to 120", async () => {
    const host = await trusted("host");
    const before = await counts();
    for (const title of [
      "",
      "   ",
      "Two\nlines",
      "Line separator",
      "Zero​width",
      "Bidi ‮override",
      "Tag \u{E0041}character",
      "x".repeat(121),
    ]) {
      const res = await party(host, { title });
      expect(res.status, JSON.stringify(title)).toBe(400);
      expect(res.body.error.code).toBe("invalid");
    }
    expect((await party(host, { title: "x".repeat(120) })).status).toBe(201);
    expect((await counts())?.gatherings).toBe((before?.gatherings ?? 0) + 1);
  });

  it("takes a start 15 minutes to 7 days ahead, as an ISO time with its offset", async () => {
    const host = await trusted("host");
    const before = await counts();
    for (const starts_at of [
      ahead(10),
      ahead(-60),
      ahead(7 * 24 * 60 + 30),
      "tomorrow at six",
      "2026-12-01T18:00:00",
      "",
      // Years Postgres can't hold, refused before the database sees them.
      "0000-01-01T00:00:00Z",
      "1999-12-31T23:59:59Z",
    ]) {
      const res = await party(host, { starts_at });
      expect(res.status, starts_at).toBe(400);
      expect(res.body.error.code).toBe("invalid");
    }
    expect(
      (await party(host, { starts_at: "0000-01-01T00:00:00Z" })).body.error
        .message,
    ).toBe("starts_at: a gathering starts 15 minutes to 7 days from now.");
    const early = await party(host, { starts_at: ahead(10) });
    expect(early.body.error.message).toBe(
      "starts_at: a gathering starts 15 minutes to 7 days from now.",
    );
    // A refused time uses no quota and writes nothing.
    expect(await counts()).toEqual(before);
    expect((await party(host, { starts_at: ahead(16) })).status).toBe(201);
    expect(
      (
        await party(host, {
          starts_at: new Date(Date.now() + 5 * 3600_000)
            .toISOString()
            .replace("Z", "+02:00"),
        })
      ).status,
    ).toBe(201);
  });

  it("takes needs from 1 to 100, and nothing else: no link, no standing, no extra field", async () => {
    const host = await trusted("host");
    for (const extra of [
      { needs: 0 },
      { needs: 101 },
      { needs: 2.5 },
      { needs: "5" },
      { url: "https://example.com" },
      { guide: "https://example.com/skill.md" },
      { bot: "someone" },
    ]) {
      const res = await party(host, extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await counts())?.gatherings).toBe(0);
  });

  it("allows 4 a day per bot, then 429 with the public number, writing nothing", async () => {
    await awayFromWindowEdge(86_400);
    const host = await trusted("host");
    for (let i = 0; i < LIMITS.gatheringPerDay.limit; i++)
      expect((await party(host)).status).toBe(201);
    const before = await counts();
    const res = await party(host);
    expect(res.status).toBe(429);
    expect(res.body.error.message).toContain("4 gatherings announced a day");
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await counts()).toEqual(before);
  });

  it("stops a flood across many bots at the private site-wide cap, never stating its number", async () => {
    await awayFromWindowEdge(86_400);
    await setAntiAbuse(db(), { gathering_global: 3 }, "Test.");
    const hosts = await Promise.all(
      ["host-a", "host-b", "host-c", "host-d"].map(trusted),
    );
    for (const h of hosts.slice(0, 3))
      expect((await party(h)).status).toBe(201);
    const before = await counts();
    const res = await party(hosts[3] as Bot);
    expect(res.status).toBe(429);
    const what = label(res.body.error.message);
    expect(what).toContain("gatherings announced across the whole site today");
    expect(what).not.toMatch(/\d/);
    expect(await counts()).toEqual(before);
  });

  it("has a default site-wide cap that's private and in range", () => {
    expect(ANTI_ABUSE_DEFAULTS.gathering_global).toBeGreaterThan(
      LIMITS.gatheringPerDay.limit,
    );
  });

  it("refuses a silenced bot, then a frozen one, and the database backs both", async () => {
    const host = await trusted("host");
    await setSilenced(db(), host.handle, 2, "Test.");
    const before = await counts();
    const silenced = await party(host);
    expect(silenced.status).toBe(403);
    expect(silenced.body.error.code).toBe("silenced");
    expect(await counts()).toEqual(before);
    const key = await keyOf(host.handle);
    await expect(db()`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at)
      SELECT id, ${key}, 'x', now() + interval '1 hour' FROM bots WHERE handle = 'host'`).rejects.toThrow(
      /silenced/,
    );
    await setSilenced(db(), host.handle, null, "Test.");
    await setFrozen(db(), host.handle, true, "Test.");
    const frozen = await party(host);
    expect(frozen.status).toBe(403);
    expect(frozen.body.error.code).toBe("frozen");
    await expect(db()`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at)
      SELECT id, ${key}, 'x', now() + interval '1 hour' FROM bots WHERE handle = 'host'`).rejects.toThrow(
      /frozen/,
    );
  });

  it("is never the house's, and only with the announcer's own live key", async () => {
    await syncWelcome(db(), "Welcome.");
    const host = await trusted("host");
    const other = await register("other");
    const key = await keyOf(other.handle);
    await expect(db()`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at)
      SELECT id, ${key}, 'x', now() + interval '1 hour' FROM bots WHERE handle = ${HOUSE_HANDLE}`).rejects.toThrow(
      /house/,
    );
    await expect(db()`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at)
      SELECT id, ${key}, 'x', now() + interval '1 hour' FROM bots WHERE handle = ${host.handle}`).rejects.toThrow(
      /own live key/,
    );
    // The window holds in the database too.
    const own = await keyOf(host.handle);
    await expect(db()`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at)
      SELECT id, ${own}, 'x', now() + interval '1 minute' FROM bots WHERE handle = ${host.handle}`).rejects.toThrow(
      /check/,
    );
  });

  it("opens to new bots when the rules say so, and the rsvp gate can hold bots back", async () => {
    await setGates(db(), { announce: [] }, "Test: open announcing.");
    const fresh = await register("fresh");
    const made = await party(fresh);
    expect(made.status).toBe(201);
    await setGates(
      db(),
      { announce: [], rsvp: [{ signal: "is_new", is: false }] },
      "Test: hold new bots back from RSVPs.",
    );
    const newcomer = await register("newcomer");
    const before = await counts();
    const held = await rsvp(newcomer, made.body.gathering.id, { going: true });
    expect(held.status).toBe(403);
    expect(held.body.error.code).toBe("not_yet");
    expect(held.body.error.message).toContain(`can't ${ACTIONS.rsvp} yet`);
    expect(await counts()).toEqual(before);
  });

  it("answers 503 to every write under the kill switch, and still lists", async () => {
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const guest = await register("guest");
    process.env.UNPROMPTED_READ_ONLY = "1";
    const before = await counts();
    expect((await party(host)).status).toBe(503);
    expect((await rsvp(guest, id, { going: true })).status).toBe(503);
    expect((await cancel(host, id)).status).toBe(503);
    expect(await counts()).toEqual(before);
    const l = await list();
    expect(l.status).toBe(200);
    expect(l.body.gatherings).toHaveLength(1);
  });
});

describe("the tables are append-only", () => {
  it("refuses UPDATE and DELETE on gatherings, their ends and RSVPs", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const id = (await party(host)).body.gathering.id;
    await rsvp(guest, id, { going: true });
    await cancel(host, id);
    for (const table of ["gatherings", "gathering_ends", "gathering_rsvps"]) {
      await expect(
        db().unsafe(
          `UPDATE ${table} SET created_at = now() - interval '1 minute'`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(db().unsafe(`DELETE FROM ${table}`)).rejects.toThrow(
        /append-only/,
      );
    }
  });

  it("holds a cancel to the announcer's key, and an RSVP row to its shape", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const id = (await party(host)).body.gathering.id;
    const guestKey = await keyOf(guest.handle);
    await expect(db()`
      INSERT INTO gathering_ends (gathering_id, kind, key_id)
      VALUES (${id}, 'cancelled', ${guestKey})`).rejects.toThrow(/announcer/);
    await expect(db()`
      INSERT INTO gathering_ends (gathering_id, kind) VALUES (${id}, 'cancelled')`).rejects.toThrow(
      /announcer|check/,
    );
    await expect(db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
      SELECT ${id}, id, ${guestKey}, 7 FROM bots WHERE handle = 'guest'`).rejects.toThrow(
      /check/,
    );
    await expect(db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id)
      SELECT ${id}, id, ${guestKey} FROM bots WHERE handle = 'guest'`).rejects.toThrow(
      /check/,
    );
    // A coming row with another bot's key slips past nothing.
    const hostKey = await keyOf(host.handle);
    await expect(db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
      SELECT ${id}, id, ${hostKey}, 10 FROM bots WHERE handle = 'guest'`).rejects.toMatchObject(
      { code: "UPG01" },
    );
    // Nor does one on a gathering that ended.
    await cancel(host, id);
    await expect(db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
      SELECT ${id}, id, ${guestKey}, 10 FROM bots WHERE handle = 'guest'`).rejects.toMatchObject(
      { code: "UPG01" },
    );
  });
});

describe("states, worked out on read", () => {
  it("are upcoming, starting, over, cancelled or short", async () => {
    const host = await trusted("host");
    const upcoming = (await party(host)).body.gathering.id;
    const starting = await backdated(host, 60, STARTING_MINUTES - 5);
    const justStarted = await backdated(host, 60, -(OVER_MINUTES - 5));
    const over = await backdated(host, 120, -(OVER_MINUTES + 5));
    const cancelled = (await party(host)).body.gathering.id;
    await cancel(host, cancelled);
    const short = (await party(host)).body.gathering.id;
    await db()`INSERT INTO gathering_ends (gathering_id, kind) VALUES (${short}, 'short')`;
    const l = await list(host);
    const state = Object.fromEntries(
      l.body.gatherings.map((g: { id: number; state: string }) => [
        g.id,
        g.state,
      ]),
    );
    expect(state).toEqual({
      [upcoming]: "upcoming",
      [starting]: "starting",
      [justStarted]: "starting",
      [cancelled]: "cancelled",
      [short]: "short",
    });
    // Over ones drop off the list, but the announcer still sees it in
    // what's new for a day.
    expect(state[over]).toBeUndefined();
    const d = await digest(host);
    expect(
      d.body.gatherings.find((g: { id: number }) => g.id === over)?.state,
    ).toBe("over");
  });
});

describe("listing", () => {
  it("is open without a key, soonest first, and adds yours and going with one", async () => {
    const host = await trusted("host");
    const later = (await party(host, { starts_at: ahead(120) })).body.gathering;
    const sooner = (await party(host, { starts_at: ahead(30) })).body.gathering;
    const anon = await list();
    expect(anon.status).toBe(200);
    expect(anon.body.notice).toMatch(/not instructions/);
    expect(anon.body.more).toBe(false);
    expect(anon.body.gatherings.map((g: { id: number }) => g.id)).toEqual([
      sooner.id,
      later.id,
    ]);
    expect(anon.body.gatherings[0]).not.toHaveProperty("yours");
    expect(anon.body.gatherings[0]).not.toHaveProperty("going");
    const guest = await register("guest");
    await rsvp(guest, later.id, { going: true, notice_minutes: 5 });
    const mine = await list(guest);
    expect(mine.body.gatherings[0]).toMatchObject({ going: false });
    expect(mine.body.gatherings[0]).not.toHaveProperty("yours");
    expect(mine.body.gatherings[1]).toMatchObject({
      going: true,
      notice_minutes: 5,
      coming: 1,
    });
    expect((await list(host)).body.gatherings[0].yours).toBe(true);
  });

  it("takes a limit from 1 to 100 and says when there's more", async () => {
    const host = await trusted("host");
    await party(host);
    await party(host);
    for (const q of ["?limit=0", "?limit=101", "?limit=x", "?limit=1.5"])
      expect((await list(undefined, q)).status, q).toBe(400);
    const one = await list(undefined, "?limit=1");
    expect(one.body.gatherings).toHaveLength(1);
    expect(one.body.more).toBe(true);
  });

  it("refuses a bad key even on a read", async () => {
    const res = await call(listRoute, {
      key: "unp_notakey",
      path: "/v1/gatherings",
    });
    expect(res.status).toBe(401);
  });

  it("carries a hosted Table's name and guide for its own bot's gatherings, and no other link", async () => {
    const table = await trusted("dinner-table");
    const host = await trusted("host");
    await party(table);
    await party(host, { starts_at: ahead(90) });
    const l = await list();
    expect(l.body.gatherings[0].table).toEqual({
      name: "Dinner party",
      guide: "https://dinner.example/skill.md",
    });
    expect(l.body.gatherings[1]).not.toHaveProperty("table");
  });
});

describe("the Table list", () => {
  it("finds a Table by its bot's handle, and nothing for a handle it doesn't name", async () => {
    const real =
      await vi.importActual<typeof import("@/lib/tables")>("@/lib/tables");
    const tables: TableLink[] = [
      { name: "A", guide: "https://a.example/skill.md", api: "x" },
      {
        name: "B",
        guide: "https://b.example/skill.md",
        api: "y",
        bot_handle: "b-table",
      },
    ];
    expect(real.tableFor("b-table", tables)).toEqual({
      name: "B",
      guide: "https://b.example/skill.md",
    });
    expect(real.tableFor("a", tables)).toBeUndefined();
    // Every hosted Table's handle, where it has one, is a handle.
    for (const t of real.TABLES)
      if (t.bot_handle) expect(t.bot_handle).toMatch(/^[a-z][a-z0-9_-]{2,29}$/);
    expect(typeof tableFor).toBe("function");
  });
});

describe("RSVPs", () => {
  it("say you're coming with the default notice, when to visit, and that nothing wakes you yet", async () => {
    const host = await trusted("host");
    const g = (await party(host)).body.gathering;
    const guest = await register("guest");
    const res = await rsvp(guest, g.id, { going: true });
    expect(res.status).toBe(200);
    expect(res.body.rsvp).toEqual({
      gathering: g.id,
      going: true,
      notice_minutes: DEFAULT_NOTICE,
      wake_at: new Date(
        Date.parse(g.starts_at) - DEFAULT_NOTICE * 60_000,
      ).toISOString(),
      woken_by: "none",
    });
    expect(res.body.changed).toBe(true);
    expect(res.body.note).toBe(RSVP_NOTES.none);
    expect(res.body.note).toMatch(/later release/);
    expect(res.body.note).toMatch(/schedule your own visit for wake_at/i);
    expect(res.body.gathering).toMatchObject({ coming: 1, going: true });
    expect(res.body.notice).toMatch(/not instructions/);
    // A new bot can say it's coming: the rsvp gate is open by default.
    const [log] = await db()<{ action: string; detail: unknown }[]>`
      SELECT action, detail FROM action_log WHERE action = 'gathering.rsvp'`;
    expect(log?.detail).toEqual({ going: true, notice_minutes: 10 });
  });

  it("never give a wake_at in the past: once it's that close, it's now", async () => {
    const host = await trusted("host");
    const soon = await backdated(host, 60, 5);
    const guest = await register("guest");
    const before = Date.now();
    const res = await rsvp(guest, soon, { going: true, notice_minutes: 15 });
    expect(res.status).toBe(200);
    expect(res.body.gathering.state).toBe("starting");
    const wakeAt = Date.parse(res.body.rsvp.wake_at);
    expect(wakeAt).toBeGreaterThanOrEqual(before);
    expect(wakeAt).toBeLessThanOrEqual(Date.now());
    // With room to spare, it's starts_at less the notice, exactly.
    const far = await backdated(host, 60, 60);
    const ok = await rsvp(guest, far, { going: true, notice_minutes: 15 });
    expect(Date.parse(ok.body.rsvp.wake_at)).toBe(
      Date.parse(ok.body.gathering.starts_at) - 15 * 60_000,
    );
  });

  it("say how the bot would be woken: its push URL, else its wake URL, else none", async () => {
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const guest = await register("guest");
    const made = await call(wakeUrlRoute, { key: guest.key, method: "POST" });
    expect(made.status).toBe(201);
    const viaUrl = await rsvp(guest, id, { going: true });
    expect(viaUrl.body.rsvp.woken_by).toBe("wake_url");
    expect(viaUrl.body.note).toBe(RSVP_NOTES.wake_url);
    expect(viaUrl.body.note).toMatch(/later release/);
    const push = await call(pushRoute, {
      key: guest.key,
      body: { url: "https://hooks.example.org/unprompted" },
    });
    expect(push.status).toBe(201);
    const viaPush = await rsvp(guest, id, { going: true, notice_minutes: 15 });
    expect(viaPush.body.rsvp.woken_by).toBe("push");
    expect(viaPush.body.note).toBe(RSVP_NOTES.push);
    // A paused push URL wakes nothing, so the wake URL is next.
    await db()`UPDATE push_state SET failures = 50`;
    const paused = await rsvp(guest, id, { going: true, notice_minutes: 5 });
    expect(paused.body.rsvp.woken_by).toBe("wake_url");
  });

  it("take 0, 5, 10 or 15 minutes' notice, only when going, and no standing RSVP yet", async () => {
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const guest = await register("guest");
    const before = await counts();
    for (const body of [
      { going: true, notice_minutes: 7 },
      { going: true, notice_minutes: 20 },
      { going: true, notice_minutes: -5 },
      { going: true, notice_minutes: "10" },
      { going: false, notice_minutes: 10 },
      { going: true, standing: true },
      { going: "yes" },
      {},
      { going: true, bot: "host" },
    ]) {
      const res = await rsvp(guest, id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await counts()).toEqual(before);
    for (const n of [0, 5, 15]) {
      const res = await rsvp(guest, id, { going: true, notice_minutes: n });
      expect(res.body.rsvp.notice_minutes).toBe(n);
    }
  });

  it("write nothing when nothing changes, and keep the notice unless asked", async () => {
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const guest = await register("guest");
    await rsvp(guest, id, { going: true, notice_minutes: 5 });
    const before = await counts();
    const again = await rsvp(guest, id, { going: true });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(again.body.rsvp.notice_minutes).toBe(5);
    expect(await counts()).toEqual(before);
    const changed = await rsvp(guest, id, { going: true, notice_minutes: 0 });
    expect(changed.body.changed).toBe(true);
    expect(changed.body.gathering.coming).toBe(1);
  });

  it("withdraw with going false, safely repeated", async () => {
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const guest = await register("guest");
    await rsvp(guest, id, { going: true });
    const out = await rsvp(guest, id, { going: false });
    expect(out.status).toBe(200);
    expect(out.body.changed).toBe(true);
    expect(out.body.rsvp).toEqual({
      gathering: id,
      going: false,
      notice_minutes: null,
      wake_at: null,
      woken_by: null,
    });
    expect(out.body.note).toBe(RSVP_NOTES.withdrawn);
    expect(out.body.gathering).toMatchObject({ coming: 0, going: false });
    const stranger = await register("stranger");
    const before = await counts();
    const again = await rsvp(guest, id, { going: false });
    expect(again.body.changed).toBe(false);
    expect(await counts()).toEqual(before);
    // Never having said it's coming is the same.
    expect((await rsvp(stranger, id, { going: false })).body.changed).toBe(
      false,
    );
    expect(await counts()).toEqual(before);
  });

  it("answer 404 for a gathering that doesn't exist or isn't an id", async () => {
    const guest = await register("guest");
    for (const id of ["999", "abc", "0", "1e3", "-1"]) {
      const res = await rsvp(guest, id, { going: true });
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe("no_such_gathering");
    }
  });

  it("are refused once a gathering is cancelled, short or over, and taken while it's starting", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const cancelled = (await party(host)).body.gathering.id;
    await cancel(host, cancelled);
    const short = (await party(host)).body.gathering.id;
    await db()`INSERT INTO gathering_ends (gathering_id, kind) VALUES (${short}, 'short')`;
    const over = await backdated(host, 120, -(OVER_MINUTES + 1));
    const starting = await backdated(host, 60, 5);
    const before = await counts();
    for (const [id, why] of [
      [cancelled, /cancelled/],
      [short, /too few/],
      [over, /over/],
    ] as const) {
      const res = await rsvp(guest, id, { going: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("gathering_closed");
      expect(res.body.error.message).toMatch(why);
    }
    expect(await counts()).toEqual(before);
    expect((await rsvp(guest, starting, { going: true })).status).toBe(200);
  });

  it("allow 60 changes an hour, then 429 writing nothing, and withdrawing always works", async () => {
    await awayFromWindowEdge(3600);
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const guest = await register("guest");
    for (let i = 0; i < LIMITS.rsvpPerHour.limit; i++) {
      expect((await rsvp(guest, id, { going: true })).status, String(i)).toBe(
        200,
      );
      // Free, so a bot at its limit can still say it isn't coming.
      expect((await rsvp(guest, id, { going: false })).status, String(i)).toBe(
        200,
      );
    }
    const before = await counts();
    const res = await rsvp(guest, id, { going: true });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toContain("60 RSVP changes an hour");
    expect(await counts()).toEqual(before);
    // A bot at its limit while coming can still withdraw.
    const keen = await register("keen");
    const notices = [0, 5, 10, 15];
    for (let i = 0; i < LIMITS.rsvpPerHour.limit; i++) {
      const res = await rsvp(keen, id, {
        going: true,
        notice_minutes: notices[i % 4],
      });
      expect(res.body.changed, String(i)).toBe(true);
    }
    expect(
      (await rsvp(keen, id, { going: true, notice_minutes: 5 })).status,
    ).toBe(429);
    const out = await rsvp(keen, id, { going: false });
    expect(out.status).toBe(200);
    expect(out.body.changed).toBe(true);
  });

  it("from a silenced bot: it can withdraw, not say it's coming", async () => {
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const guest = await register("guest");
    await rsvp(guest, id, { going: true });
    await setSilenced(db(), guest.handle, 2, "Test.");
    const res = await rsvp(guest, id, { going: true, notice_minutes: 5 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("silenced");
    expect((await rsvp(guest, id, { going: false })).status).toBe(200);
  });

  it("stop counting while the bot is frozen, or once its key is rotated or revoked", async () => {
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const a = await register("guest-a");
    const b = await register("guest-b");
    const c = await register("guest-c");
    for (const g of [a, b, c]) await rsvp(g, id, { going: true });
    const coming = async () =>
      (await list()).body.gatherings[0].coming as number;
    expect(await coming()).toBe(3);
    await setFrozen(db(), a.handle, true, "Test.");
    expect(await coming()).toBe(2);
    await setFrozen(db(), a.handle, false, "Test.");
    expect(await coming()).toBe(3);
    const rotated = await call(rotateRoute, { key: b.key });
    expect(rotated.status).toBe(200);
    expect(await coming()).toBe(2);
    await call(revokeRoute, { key: c.key });
    expect(await coming()).toBe(1);
    // The new key says it again.
    const b2 = { handle: b.handle, key: rotated.body.api_key as string };
    expect((await rsvp(b2, id, { going: true })).body.changed).toBe(true);
    expect(await coming()).toBe(2);
  });

  it("end when the bot blocks the announcer, and unblocking doesn't bring them back", async () => {
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const other = (await party(host, { starts_at: ahead(200) })).body.gathering
      .id;
    const guest = await register("guest");
    await rsvp(guest, id, { going: true });
    await rsvp(guest, other, { going: true });
    expect((await block(guest, host.handle)).status).toBe(200);
    expect(
      (await list()).body.gatherings.map((g: { coming: number }) => g.coming),
    ).toEqual([0, 0]);
    // While blocking, it can't say it's coming: its own block, so nothing leaks.
    const refused = await rsvp(guest, id, { going: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("you_blocked");
    await unblock(guest, host.handle);
    expect(
      (await list()).body.gatherings.map((g: { coming: number }) => g.coming),
    ).toEqual([0, 0]);
    expect((await rsvp(guest, id, { going: true })).body.changed).toBe(true);
    expect((await list()).body.gatherings[0].coming).toBe(1);
  });

  it("read the same whether or not the announcer blocked the bot, so they can't probe a block", async () => {
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const plain = await register("plain");
    const blocked = await register("blocked");
    expect((await block(host, blocked.handle)).status).toBe(200);
    const shape = (res: { status: number; body: Record<string, unknown> }) =>
      JSON.stringify({
        status: res.status,
        keys: Object.keys(res.body).sort(),
        rsvp: { ...(res.body.rsvp as object), wake_at: null },
        changed: res.body.changed,
        note: res.body.note,
        going: (res.body.gathering as { going: boolean }).going,
      });
    const a = await rsvp(plain, id, { going: true });
    const b = await rsvp(blocked, id, { going: true });
    expect(shape(b)).toBe(shape(a));
    expect(b.body.gathering.coming).toBe(2);
    // Withdrawing reads the same too.
    expect(shape(await rsvp(blocked, id, { going: false }))).toBe(
      shape(await rsvp(plain, id, { going: false })),
    );
  });

  it("are never the house's", async () => {
    await syncWelcome(db(), "Welcome.");
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const key = await keyOf(host.handle);
    await expect(db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
      SELECT ${id}, id, ${key}, 10 FROM bots WHERE handle = ${HOUSE_HANDLE}`).rejects.toMatchObject(
      { code: "UPG01" },
    );
  });
});

describe("who's coming", () => {
  it("is a count for everyone, the announcer included: no read names a bot that's coming", async () => {
    const host = await trusted("host");
    const id = (await party(host)).body.gathering.id;
    const guests = await Promise.all(
      ["quiet-ana", "quiet-ben", "quiet-cy"].map((h) => register(h)),
    );
    for (const g of guests) await rsvp(g, id, { going: true });
    const third = await register("onlooker");
    const answers = [
      await list(host),
      await list(),
      await list(third),
      await digest(host),
      await digest(third),
      await cancel(host, id),
    ];
    for (const res of answers) {
      const text = JSON.stringify(res.body);
      for (const g of guests) expect(text).not.toContain(g.handle);
    }
    expect(answers[0]?.body.gatherings[0].coming).toBe(3);
    // A guest's own answer names only itself, never the others.
    const own = JSON.stringify(
      (await rsvp(guests[0] as Bot, id, { going: false })).body,
    );
    expect(own).not.toContain("quiet-ben");
    expect(own).not.toContain("quiet-cy");
  });
});

describe("cancelling", () => {
  it("is for the announcer only, safe to repeat, logged, and closes the gathering", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const id = (await party(host)).body.gathering.id;
    await rsvp(guest, id, { going: true });
    const before = await counts();
    const notYours = await cancel(guest, id);
    expect(notYours.status).toBe(403);
    expect(notYours.body.error.code).toBe("not_your_gathering");
    expect(await counts()).toEqual(before);
    const res = await cancel(host, id);
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.gathering).toMatchObject({
      state: "cancelled",
      yours: true,
    });
    const after = await counts();
    const again = await cancel(host, id, {});
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(await counts()).toEqual(after);
    const [log] = await db()<{ subject: string }[]>`
      SELECT subject FROM action_log WHERE action = 'gathering.cancel'`;
    expect(log?.subject).toBe(`gathering:${id}`);
    // The guest finds out from what's new.
    const d = await digest(guest);
    expect(d.body.gatherings[0]).toMatchObject({ id, state: "cancelled" });
  });

  it("refuses an unknown id, a body, and a gathering that's over or already short", async () => {
    const host = await trusted("host");
    expect((await cancel(host, 999)).status).toBe(404);
    expect((await cancel(host, "abc")).status).toBe(404);
    const id = (await party(host)).body.gathering.id;
    expect((await cancel(host, id, { reason: "x" })).status).toBe(400);
    const over = await backdated(host, 120, -(OVER_MINUTES + 1));
    const res = await cancel(host, over);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("gathering_over");
    const short = (await party(host)).body.gathering.id;
    await db()`INSERT INTO gathering_ends (gathering_id, kind) VALUES (${short}, 'short')`;
    const before = await counts();
    const s = await cancel(host, short);
    expect(s.body).toMatchObject({
      changed: false,
      gathering: { state: "short" },
    });
    expect(await counts()).toEqual(before);
  });
});

describe("at the same time", () => {
  // Every answer here must be a refusal a bot can act on, never a 500.
  const statuses = (rs: { status: number }[]) =>
    rs.map((r) => r.status).filter((s) => s >= 500);

  it("cancels raced against each other change it once and all answer 200", async () => {
    const host = await trusted("host");
    for (let round = 0; round < 8; round++) {
      const id = await backdated(host, 0, 60);
      const answers = await Promise.all(
        Array.from({ length: 4 }, () => cancel(host, id)),
      );
      expect(statuses(answers), String(round)).toEqual([]);
      expect(answers.every((r) => r.status === 200)).toBe(true);
      expect(answers.filter((r) => r.body.changed === true)).toHaveLength(1);
    }
    const [n] = await db()<{ ends: number }[]>`
      SELECT count(*)::int AS ends FROM gathering_ends`;
    expect(n?.ends).toBe(8);
  });

  it("RSVPs, blocks of the announcer and cancels raced together never deadlock", async () => {
    const host = await trusted("host");
    const guests: Bot[] = [];
    for (let i = 0; i < 4; i++) guests.push(await register(`racer-${i}`));
    const notices = [0, 5, 15];
    for (let round = 0; round < 100; round++) {
      await db()`DELETE FROM rate_limits WHERE bucket LIKE 'rsvp%'`;
      const id = await backdated(host, 0, 60);
      for (const g of guests) await rsvp(g, id, { going: true });
      const ops: Promise<{ status: number }>[] = [];
      for (const [i, g] of guests.entries()) {
        ops.push(
          rsvp(g, id, {
            going: true,
            notice_minutes: notices[(round + i) % 3],
          }),
        );
        ops.push(block(g, host.handle));
      }
      ops.push(cancel(host, id), cancel(host, id));
      const answers = await Promise.all(ops);
      expect(statuses(answers), String(round)).toEqual([]);
      for (const g of guests) await unblock(g, host.handle);
    }
  });
});

describe("moderation", () => {
  it("hides a gathering from every read, RSVP and cancel, logged with its reason, and puts it back as it was", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const id = (await party(host)).body.gathering.id;
    await rsvp(guest, id, { going: true });
    const hid = await setGatheringHidden(db(), id, true, "Test: spam title.");
    expect(hid).toEqual({ changed: true, message: `Hid gathering ${id}.` });
    expect((await setGatheringHidden(db(), id, true, "Again.")).changed).toBe(
      false,
    );
    expect((await list()).body.gatherings).toEqual([]);
    expect((await list(guest)).body.gatherings).toEqual([]);
    expect((await digest(guest)).body.gatherings).toEqual([]);
    expect((await digest(host)).body.gatherings).toEqual([]);
    for (const res of [
      await rsvp(guest, id, { going: true, notice_minutes: 5 }),
      await rsvp(guest, id, { going: false }),
      await cancel(host, id),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("no_such_gathering");
    }
    const [log] = await db()<{ subject: string; detail: { reason: string } }[]>`
      SELECT subject, detail FROM action_log WHERE action = 'admin.gathering.hide'`;
    expect(log).toMatchObject({
      subject: `gathering:${id}`,
      detail: { reason: "Test: spam title." },
    });
    const look = await lookupBot(db(), host.handle);
    expect(look?.gatherings_announced).toEqual([
      {
        id,
        title: "Dinner party, five seats",
        starts_at: expect.any(Date),
        state: "upcoming",
        coming: 1,
        hidden: true,
      },
    ]);
    expect(look?.history.map((h) => h.action)).toContain("gathering.hide");
    await setGatheringHidden(db(), id, false, "Test: fine after all.");
    expect((await list()).body.gatherings[0]).toMatchObject({ id, coming: 1 });
    expect((await setGatheringHidden(db(), id, false, "Again.")).changed).toBe(
      false,
    );
    await expect(
      setGatheringHidden(db(), 999, true, "No such."),
    ).rejects.toMatchObject({ code: "no_such_gathering" });
    await expect(setGatheringHidden(db(), id, true, "")).rejects.toMatchObject({
      code: "invalid_reason",
    });
  });

  it("takes a frozen or banned announcer's gatherings off every read, and back on unfreezing", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const id = (await party(host)).body.gathering.id;
    await rsvp(guest, id, { going: true });
    await setFrozen(db(), host.handle, true, "Test.");
    expect((await list()).body.gatherings).toEqual([]);
    expect((await digest(guest)).body.gatherings).toEqual([]);
    const res = await rsvp(guest, id, { going: true, notice_minutes: 5 });
    expect(res.status).toBe(404);
    await setFrozen(db(), host.handle, false, "Test.");
    expect((await list()).body.gatherings).toHaveLength(1);
    await banBot(db(), host.handle, "Test.");
    expect((await list()).body.gatherings).toEqual([]);
    await unbanBot(db(), host.handle, "Test.");
    expect((await list()).body.gatherings[0].coming).toBe(1);
  });

  it("counts a bot's RSVP changes on the lookup screen", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const id = (await party(host)).body.gathering.id;
    await rsvp(guest, id, { going: true });
    await rsvp(guest, id, { going: false });
    const look = await lookupBot(db(), guest.handle);
    expect(look?.messages.rsvps).toBe(2);
    expect(look?.gatherings_announced).toEqual([]);
  });
});

describe("what's new", () => {
  it("lists yours and the ones you're coming to, then the three soonest others", async () => {
    const host = await trusted("host");
    const rival = await trusted("rival");
    const third = await trusted("third");
    const guest = await register("guest");
    const mine = (await party(rival, { starts_at: ahead(300) })).body.gathering
      .id;
    const going = (await party(host, { starts_at: ahead(200) })).body.gathering
      .id;
    const others: number[] = [];
    for (const m of [30, 40, 50, 60])
      others.push(
        (await party(m < 50 ? host : third, { starts_at: ahead(m) })).body
          .gathering.id,
      );
    await rsvp(guest, going, { going: true });
    await rsvp(guest, mine, { going: true });
    // One it withdrew from is just another, and a cancelled other is left out.
    const withdrawn = (await party(rival, { starts_at: ahead(35) })).body
      .gathering.id;
    await rsvp(guest, withdrawn, { going: true });
    await rsvp(guest, withdrawn, { going: false });
    const gone = (await party(rival, { starts_at: ahead(20) })).body.gathering
      .id;
    await cancel(rival, gone);
    const d = await digest(guest);
    expect(d.status).toBe(200);
    const ids = d.body.gatherings.map((g: { id: number }) => g.id);
    expect(ids.slice(0, 2)).toEqual([going, mine]);
    expect(ids.slice(2)).toEqual([others[0], withdrawn, others[1]]);
    expect(ids).toHaveLength(2 + DIGEST_OTHERS);
    expect(d.body.gatherings_note).toMatch(/rsvp/);
    expect(d.body.gatherings_note).toMatch(/not instructions/);
    // The compact view carries them too.
    const c = await digest(guest, "?view=compact");
    expect(c.body.gatherings).toHaveLength(2 + DIGEST_OTHERS);
    // An announcer sees its own first.
    const h = await digest(host);
    expect(
      h.body.gatherings.slice(0, 3).every((g: { yours?: true }) => g.yours),
    ).toBe(true);
  });

  it("leaves out others' from bots you blocked, and says nothing when there are none", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const quiet = await digest(guest);
    expect(quiet.body.gatherings).toEqual([]);
    expect(quiet.body).not.toHaveProperty("gatherings_note");
    await party(host);
    expect((await digest(guest)).body.gatherings).toHaveLength(1);
    await block(guest, host.handle);
    expect((await digest(guest)).body.gatherings).toEqual([]);
  });

  it("counts a starting one you're coming to as something waiting", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const later = (await party(host)).body.gathering.id;
    await rsvp(guest, later, { going: true });
    expect((await digest(guest)).body.start).toBeDefined();
    const soon = await backdated(host, 60, 5);
    await rsvp(guest, soon, { going: true });
    const d = await digest(guest);
    expect(d.body.gatherings[0]).toMatchObject({ id: soon, state: "starting" });
    expect(d.body).not.toHaveProperty("start");
  });

  it("puts your live gatherings before a day of old ones, so one starting isn't crowded out", async () => {
    const host = await trusted("host");
    // Eleven over in the last day, more than what's new lists of yours.
    for (let i = 0; i < 11; i++) await backdated(host, 200 + i, -120 - i);
    const soon = await backdated(host, 60, 5);
    const later = await backdated(host, 60, 90);
    const d = await digest(host);
    const states = d.body.gatherings.map((g: { state: string }) => g.state);
    expect(d.body.gatherings[0]).toMatchObject({ id: soon, state: "starting" });
    expect(d.body.gatherings[1]).toMatchObject({
      id: later,
      state: "upcoming",
    });
    expect(states.slice(2).every((s: string) => s === "over")).toBe(true);
  });
});

describe("nothing branches on who a bot is", () => {
  it("reads no test mark: a test bot's gatherings and RSVPs work like anyone's", async () => {
    const src = [
      readFileSync(path.join(process.cwd(), "src/lib/gatherings.ts"), "utf8"),
      readFileSync(
        path.join(process.cwd(), "db/migrations/042_gatherings.sql"),
        "utf8",
      ),
      ...["route.ts", "[id]/cancel/route.ts", "[id]/rsvp/route.ts"].map((f) =>
        readFileSync(
          path.join(process.cwd(), "src/app/v1/gatherings", f),
          "utf8",
        ),
      ),
    ].join("\n");
    expect(src).not.toMatch(/is_test|bot_is_test|test_bot_marks/);
    const host = await trusted("host");
    const guest = await register("guest");
    await setTestMark(db(), host.handle, true, "Test.");
    await setTestMark(db(), guest.handle, true, "Test.");
    const id = (await party(host)).body.gathering.id;
    expect((await rsvp(guest, id, { going: true })).status).toBe(200);
    const plain = await register("plain");
    const d = await digest(plain);
    expect(d.body.gatherings[0]).toMatchObject({ id, coming: 1 });
    expect(d.body.gatherings[0]).not.toHaveProperty("is_test");
  });
});

describe("the routes and tools", () => {
  it("need a key for every write", async () => {
    for (const res of [
      await call(announceRoute, { body: { title: "x", starts_at: ahead(60) } }),
      await call(rsvpRoute, { body: { going: true }, params: { id: "1" } }),
      await call(cancelRoute, { method: "POST", params: { id: "1" } }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("missing_key");
    }
  });

  it("are in the OpenAPI description", () => {
    expect(OPERATIONS["/v1/gatherings"]?.get?.key).toBe("optional");
    expect(OPERATIONS["/v1/gatherings"]?.post?.key).toBe("required");
    expect(OPERATIONS["/v1/gatherings/{id}/cancel"]?.post?.key).toBe(
      "required",
    );
    expect(OPERATIONS["/v1/gatherings/{id}/rsvp"]?.post?.key).toBe("required");
  });

  let rpcId = 0;
  async function tool(key: string, name: string, args: object = {}) {
    rpcId += 1;
    const req = new Request("http://unprompted.test/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-real-ip": freshIp(),
        host: "unprompted.test",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const result = (await (await mcpRoute(req, undefined as never)).json())
      .result;
    const text = (result?.content?.[0]?.text ?? "") as string;
    // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: result?.isError === true, data };
  }

  it("work the same through the connector", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const refused = await tool(guest.key, "announce_gathering", {
      title: "Too soon to host",
      starts_at: ahead(60),
    });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe("not_yet");
    const made = await tool(host.key, "announce_gathering", {
      title: "Mafia, seven seats",
      starts_at: ahead(60),
      needs: 7,
    });
    expect(made.isError).toBe(false);
    const id = made.data.gathering.id as number;
    expect(made.data.gathering.untrusted_title).toBe("Mafia, seven seats");
    const r = await tool(guest.key, "rsvp", {
      gathering: id,
      going: true,
      notice_minutes: 5,
    });
    expect(r.isError).toBe(false);
    expect(r.data.rsvp).toMatchObject({ going: true, woken_by: "none" });
    const bad = await tool(guest.key, "rsvp", {
      gathering: id,
      going: false,
      notice_minutes: 5,
    });
    expect(bad.isError).toBe(true);
    const onlooker = await register("onlooker");
    const l = await tool(onlooker.key, "list_gatherings");
    expect(l.data.gatherings[0]).toMatchObject({ id, coming: 1, going: false });
    const mine = await tool(guest.key, "list_gatherings", { limit: 5 });
    expect(mine.data.gatherings[0].going).toBe(true);
    const notYours = await tool(guest.key, "cancel_gathering", {
      gathering: id,
    });
    expect(notYours.data.error.code).toBe("not_your_gathering");
    const c = await tool(host.key, "cancel_gathering", { gathering: id });
    expect(c.data).toMatchObject({
      changed: true,
      gathering: { state: "cancelled" },
    });
    const d = await tool(guest.key, "read_digest", {});
    expect(d.data.gatherings[0].state).toBe("cancelled");
    expect(d.data.gatherings_note).toMatch(/rsvp/);
  });
});
