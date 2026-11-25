import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
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
import { banBot, setFrozen, unbanBot } from "@/lib/admin";
import { connectWithCode, issueConnectCode } from "@/lib/connect-codes";
import { db } from "@/lib/db";
import { workDue } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { RSVP_NOTES } from "@/lib/gatherings";
import { hashIp } from "@/lib/http";
import { issueOwnerCode } from "@/lib/humans";
import { hashKey } from "@/lib/keys";
import { GATHERING_CAPACITY_MAX, GATHERING_WAITLIST_MAX } from "@/lib/validate";
import { ageLink, call, freshIp, linkBot, register, resetDb } from "./helpers";

// A gathering's capacity and waitlist (EV2a, 084_gathering_capacity.sql).
// Bots take the seats in the order they first said they're coming; then the
// next ones wait in that order. When a bot with a seat withdraws, the first
// waiting gets it and is woken at once. Reads show the capacity, whether
// it's full and how many wait, and a bot its own place; never who.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

async function botId(b: Bot): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${b.handle}`;
  return Number(r?.id);
}

async function wakeCount(b: Bot): Promise<number> {
  const [r] = await db()<{ count: string }[]>`
    SELECT w.count FROM wake_counters w JOIN bots b ON b.id = w.bot_id
    WHERE b.handle = ${b.handle}`;
  return Number(r?.count ?? 0);
}

// Written straight to the table, so a test needn't clear the announce gate
// or the announce window.
async function gathering(
  host: Bot,
  capacity: number | null,
  inMinutes = 60,
): Promise<number> {
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, capacity, created_at)
    SELECT b.id, k.id, 'Jam', now() + make_interval(mins => ${inMinutes}),
           ${capacity}, now() - interval '1 hour'
    FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
    WHERE b.handle = ${host.handle}
    RETURNING id`;
  return Number(g?.id);
}

const rsvp = (b: Bot, id: number, body: object) =>
  call(rsvpRoute, {
    key: b.key,
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/rsvp`,
  });

// biome-ignore lint/suspicious/noExplicitAny: test reads JSON
async function viewOf(b: Bot, id: number): Promise<any> {
  const res = await call(listRoute, { key: b.key, path: "/v1/gatherings" });
  expect(res.status).toBe(200);
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return res.body.gatherings.find((g: any) => g.id === id);
}

// The bot's own items on the due-list from a day back to two hours ahead.
async function dueKinds(b: Bot, id: number): Promise<string[]> {
  const rows = await db()<{ kind: string }[]>`
    SELECT kind FROM due_items(now() - interval '1 day',
                               now() + interval '2 hours', ${await botId(b)})
    WHERE event_id = ${id} AND kind IN ('rsvp', 'start', 'moved', 'short')
    ORDER BY kind`;
  return rows.map((r) => r.kind);
}

// Four guests at a gathering with two seats: a and b seated, c and d
// waiting, in that order.
async function fullHouse() {
  const host = await register("host");
  const a = await register("guest-a");
  const b = await register("guest-b");
  const c = await register("guest-c");
  const d = await register("guest-d");
  const id = await gathering(host, 2);
  for (const g of [a, b, c, d])
    expect((await rsvp(g, id, { going: true })).status).toBe(200);
  return { host, a, b, c, d, id };
}

describe("seats and the waitlist", () => {
  it("seats the first to say so and puts the rest in line", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const b = await register("guest-b");
    const c = await register("guest-c");
    const id = await gathering(host, 2);
    const first = await rsvp(a, id, { going: true });
    expect(first.body.rsvp.waitlist_place).toBeUndefined();
    expect(first.body.rsvp.wake_at).not.toBeNull();
    expect(first.body.gathering).toMatchObject({
      capacity: 2,
      full: false,
      waiting: 0,
      coming: 1,
      going: true,
    });
    await rsvp(b, id, { going: true });
    const third = await rsvp(c, id, { going: true });
    expect(third.status).toBe(200);
    expect(third.body.changed).toBe(true);
    expect(third.body.rsvp.going).toBe(true);
    expect(third.body.rsvp.waitlist_place).toBe(1);
    expect(third.body.rsvp.wake_at).toBeNull();
    // Nothing wakes c (no event, routine, push or wake URL), so it's told
    // to look again rather than count on hearing.
    expect(third.body.note).toBe(
      `${RSVP_NOTES.waiting} ${RSVP_NOTES.waiting_unwoken}`,
    );
    expect(third.body.gathering).toMatchObject({
      capacity: 2,
      full: true,
      waiting: 1,
      coming: 2,
      going: false,
      waitlist_place: 1,
    });
    // Saying it again keeps the place and writes nothing.
    const again = await rsvp(c, id, { going: true });
    expect(again.body.changed).toBe(false);
    expect(again.body.rsvp.waitlist_place).toBe(1);
    // Others see the counts, and never anyone's place but their own.
    const theirs = await viewOf(a, id);
    expect(theirs).toMatchObject({ full: true, waiting: 1, going: true });
    expect(theirs.waitlist_place).toBeUndefined();
    const hosts = await viewOf(host, id);
    expect(hosts).toMatchObject({ yours: true, coming: 2, waiting: 1 });
    expect(JSON.stringify(hosts)).not.toContain(c.handle);
  });

  it("hands a freed seat to the first waiting, wakes it, and tells the announcer nothing", async () => {
    const { host, a, c, d, id } = await fullHouse();
    const hostBefore = await wakeCount(host);
    const cBefore = await wakeCount(c);
    const dBefore = await wakeCount(d);
    const res = await rsvp(a, id, { going: false, reason: "unavailable" });
    expect(res.status).toBe(200);
    expect(res.body.rsvp.reason).toBe("unavailable");
    expect(JSON.stringify(res.body)).not.toContain(c.handle);
    expect(await wakeCount(c)).toBe(cBefore + 1);
    expect(await wakeCount(d)).toBe(dBefore);
    // The seat didn't open: it went to c.
    expect(await wakeCount(host)).toBe(hostBefore);
    const hosts = await viewOf(host, id);
    expect(hosts.seat_opened_at).toBeUndefined();
    expect(hosts).toMatchObject({ coming: 2, waiting: 1, full: true });
    expect(await viewOf(c, id)).toMatchObject({
      going: true,
      notice_minutes: 10,
    });
    expect((await viewOf(c, id)).waitlist_place).toBeUndefined();
    expect((await viewOf(d, id)).waitlist_place).toBe(1);
    // The moderators' record says which bot got it, never the reason.
    const [log] = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.rsvp'
      ORDER BY id DESC LIMIT 1`;
    expect(log?.detail.promoted).toBe(await botId(c));
    expect(JSON.stringify(log?.detail)).not.toContain("unavailable");
  });

  it("frees nothing when a bot only waiting leaves, and moves the line up", async () => {
    const { host, c, d, id } = await fullHouse();
    const before = [await wakeCount(host), await wakeCount(d)];
    expect((await rsvp(c, id, { going: false })).status).toBe(200);
    expect([await wakeCount(host), await wakeCount(d)]).toEqual(before);
    expect((await viewOf(d, id)).waitlist_place).toBe(1);
    expect(await viewOf(host, id)).toMatchObject({ coming: 2, waiting: 1 });
  });

  it("opens a seat for the announcer when nobody waits", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const b = await register("guest-b");
    const id = await gathering(host, 2);
    await rsvp(a, id, { going: true });
    await rsvp(b, id, { going: true });
    const before = await wakeCount(host);
    await rsvp(a, id, { going: false });
    expect(await wakeCount(host)).toBe(before + 1);
    expect((await viewOf(host, id)).seat_opened_at).toBeDefined();
    expect(await viewOf(host, id)).toMatchObject({ full: false, coming: 1 });
  });

  it("keeps a place across a change of notice, and sends a bot that comes back to the end", async () => {
    const { a, c, d, id } = await fullHouse();
    const moved = await rsvp(c, id, { going: true, notice_minutes: 5 });
    expect(moved.body.changed).toBe(true);
    expect(moved.body.rsvp.waitlist_place).toBe(1);
    expect(
      (await rsvp(a, id, { going: true, notice_minutes: 15 })).body.rsvp
        .waitlist_place,
    ).toBeUndefined();
    await rsvp(a, id, { going: false });
    // c had the first place: it gets a's seat.
    expect((await viewOf(c, id)).going).toBe(true);
    const back = await rsvp(a, id, { going: true });
    expect(back.body.rsvp.waitlist_place).toBe(2);
    expect((await viewOf(d, id)).waitlist_place).toBe(1);
  });

  it("gives up a seat with its key, wakes the first waiting, and starts over at the end with a new one", async () => {
    const { host, a, c, id } = await fullHouse();
    const cBefore = await wakeCount(c);
    const hostBefore = await wakeCount(host);
    const rotated = await call(rotateRoute, { key: a.key });
    expect(rotated.status).toBe(200);
    const a2 = { handle: a.handle, key: rotated.body.api_key as string };
    // The seat goes with the key (086_seat_release.sql): c holds it now,
    // woken at once; the announcer hears nothing of a lost key.
    expect((await viewOf(c, id)).going).toBe(true);
    expect(await wakeCount(c)).toBe(cBefore + 1);
    expect(await wakeCount(host)).toBe(hostBefore);
    expect((await viewOf(host, id)).seat_opened_at).toBeUndefined();
    const back = await rsvp(a2, id, { going: true });
    expect(back.body.rsvp.waitlist_place).toBe(2);
    // The moderators' record names why and who got it.
    const [log] = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.seat_release'`;
    expect(log?.detail).toEqual({ why: "key", promoted: await botId(c) });
  });

  it("hands a frozen bot's seat on, wakes the first waiting, and gives nothing back when it thaws", async () => {
    const { host, a, c, d, id } = await fullHouse();
    const cBefore = await wakeCount(c);
    const hostBefore = await wakeCount(host);
    await setFrozen(db(), a.handle, true, "Testing.");
    expect(await viewOf(host, id)).toMatchObject({
      coming: 2,
      full: true,
      waiting: 1,
    });
    expect((await viewOf(c, id)).going).toBe(true);
    expect((await viewOf(d, id)).waitlist_place).toBe(1);
    expect(await wakeCount(c)).toBe(cBefore + 1);
    expect(await wakeCount(host)).toBe(hostBefore);
    await setFrozen(db(), a.handle, false, "Testing.");
    expect(await viewOf(host, id)).toMatchObject({ coming: 2, waiting: 1 });
    expect((await viewOf(a, id)).going).toBe(false);
    // Saying it's coming again puts it at the back.
    expect((await rsvp(a, id, { going: true })).body.rsvp.waitlist_place).toBe(
      2,
    );
  });

  it("hands a seat on while a long gathering runs, past the 30 minutes after its start", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const b = await register("guest-b");
    // Started an hour ago and lasts three: running, and taking RSVPs.
    const [g] = await db()<{ id: string }[]>`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, lasts_minutes, capacity, created_at)
      SELECT b.id, k.id, 'Jam', now() - interval '60 minutes', 180, 1, now() - interval '1 day'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${host.handle}
      RETURNING id`;
    const id = Number(g?.id);
    expect((await rsvp(a, id, { going: true })).status).toBe(200);
    expect((await rsvp(b, id, { going: true })).body.rsvp.waitlist_place).toBe(
      1,
    );
    const bBefore = await wakeCount(b);
    await setFrozen(db(), a.handle, true, "Testing.");
    expect((await viewOf(b, id)).going).toBe(true);
    expect((await viewOf(b, id)).waitlist_place).toBeUndefined();
    expect(await wakeCount(b)).toBe(bBefore + 1);
  });

  it("hands a seat on with a rotated key while a long gathering runs", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const b = await register("guest-b");
    // Started an hour ago and lasts three: running, and taking RSVPs.
    const [g] = await db()<{ id: string }[]>`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, lasts_minutes, capacity, created_at)
      SELECT b.id, k.id, 'Jam', now() - interval '60 minutes', 180, 1, now() - interval '1 day'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${host.handle}
      RETURNING id`;
    const id = Number(g?.id);
    expect((await rsvp(a, id, { going: true })).status).toBe(200);
    expect((await rsvp(b, id, { going: true })).body.rsvp.waitlist_place).toBe(
      1,
    );
    const bBefore = await wakeCount(b);
    expect((await call(rotateRoute, { key: a.key })).status).toBe(200);
    expect((await viewOf(b, id)).going).toBe(true);
    expect((await viewOf(b, id)).waitlist_place).toBeUndefined();
    expect(await wakeCount(b)).toBe(bBefore + 1);
  });

  it("releases nothing once a gathering has ended, cancelled or short", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const b = await register("guest-b");
    // One its announcer cancels and one the clock called short: a's seat
    // goes without a release in either, and b waits on. (Nothing can hold a
    // seat past a gathering's end: the site refuses an RSVP to one that's
    // over, and the two running tests above cover the window before it.)
    const cancelled = await gathering(host, 1);
    const short = await gathering(host, 1);
    for (const id of [cancelled, short]) {
      expect((await rsvp(a, id, { going: true })).status).toBe(200);
      expect(
        (await rsvp(b, id, { going: true })).body.rsvp.waitlist_place,
      ).toBe(1);
    }
    expect(
      (
        await call(cancelRoute, {
          key: host.key,
          method: "POST",
          params: { id: String(cancelled) },
          path: `/v1/gatherings/${cancelled}/cancel`,
        })
      ).status,
    ).toBe(200);
    await db()`
      INSERT INTO gathering_ends (gathering_id, kind) VALUES (${short}, 'short')`;
    const bBefore = await wakeCount(b);
    await setFrozen(db(), a.handle, true, "Testing.");
    const rows = await db()<{ gathering_id: string }[]>`
      SELECT gathering_id FROM gathering_rsvps WHERE released_by IS NOT NULL`;
    expect(rows).toHaveLength(0);
    expect(await wakeCount(b)).toBe(bBefore);
    const log = await db()`
      SELECT 1 FROM action_log WHERE action = 'gathering.seat_release'`;
    expect(log).toHaveLength(0);
  });

  it("lets a frozen bot's place in line go, so a seat never goes to it", async () => {
    const { a, c, d, id } = await fullHouse();
    await setFrozen(db(), c.handle, true, "Testing.");
    expect((await viewOf(d, id)).waitlist_place).toBe(1);
    const dBefore = await wakeCount(d);
    await rsvp(a, id, { going: false });
    expect((await viewOf(d, id)).going).toBe(true);
    expect(await wakeCount(d)).toBe(dBefore + 1);
    const [log] = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.seat_release'`;
    expect(log?.detail).toEqual({ why: "frozen" });
  });

  it("releases a banned bot's seats, and leaves a gathering without a capacity as it was", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const c = await register("guest-c");
    const open = await gathering(host, null);
    const capped = await gathering(host, 1);
    await rsvp(a, open, { going: true });
    await rsvp(a, capped, { going: true });
    await rsvp(c, capped, { going: true });
    const cBefore = await wakeCount(c);
    await banBot(db(), a.handle, "Testing.");
    expect((await viewOf(c, capped)).going).toBe(true);
    expect(await wakeCount(c)).toBe(cBefore + 1);
    // Without a capacity a frozen bot's RSVP stands, uncounted, as before.
    const [r] = await db()<{ key_id: string | null }[]>`
      SELECT key_id FROM gathering_rsvps
      WHERE gathering_id = ${open} AND bot_id = ${await botId(a)}
      ORDER BY id DESC LIMIT 1`;
    expect(r?.key_id).not.toBeNull();
    await unbanBot(db(), a.handle, "Testing.");
    expect((await viewOf(a, open)).going).toBe(true);
    expect((await viewOf(a, capped)).going).toBe(false);
  });

  it("hands on every seat a connect code's new key ends, in one go, however many keys it held", async () => {
    const host = await register("host");
    const owner_code = (await issueOwnerCode(db(), "google-seats", null)).code;
    const a = await register("guest-a", { owner_code });
    await ageLink(a.handle);
    const c = await register("guest-c");
    const e = await register("guest-e");
    const one = await gathering(host, 1);
    const two = await gathering(host, 1);
    expect((await rsvp(a, one, { going: true })).status).toBe(200);
    // A second live key of a's, seated at the other gathering.
    const [k2] = await db()<{ id: string }[]>`
      INSERT INTO api_keys (bot_id, key_hash, prefix)
      VALUES (${await botId(a)}, ${"f".repeat(64)}, 'two') RETURNING id`;
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
      VALUES (${two}, ${await botId(a)}, ${k2?.id ?? null}, 10)`;
    await rsvp(e, one, { going: true });
    await rsvp(c, two, { going: true });
    const cBefore = await wakeCount(c);
    const eBefore = await wakeCount(e);
    const code = (await issueConnectCode(db(), "google-seats", a.handle, null))
      .code;
    await connectWithCode({ handle: a.handle, code }, hashIp(freshIp()));
    expect((await viewOf(c, two)).going).toBe(true);
    expect((await viewOf(e, one)).going).toBe(true);
    expect(await wakeCount(c)).toBe(cBefore + 1);
    expect(await wakeCount(e)).toBe(eBefore + 1);
    // One statement: both released before any key's own trigger, logged
    // without a key, and no second release.
    const logs = await db()<
      { key_id: string | null; detail: { why: string } }[]
    >`
      SELECT key_id, detail FROM action_log
      WHERE action = 'gathering.seat_release' AND bot_id = ${await botId(a)}`;
    expect(logs).toHaveLength(2);
    for (const l of logs) {
      expect(l.key_id).toBeNull();
      expect(l.detail.why).toBe("key");
    }
  });

  it("hands on a seat when a bot revokes its own key", async () => {
    const { a, c, host, id } = await fullHouse();
    const cBefore = await wakeCount(c);
    const hostBefore = await wakeCount(host);
    expect((await call(revokeRoute, { key: a.key })).status).toBe(200);
    expect((await viewOf(c, id)).going).toBe(true);
    expect(await wakeCount(c)).toBe(cBefore + 1);
    expect(await wakeCount(host)).toBe(hostBefore);
  });

  it("refuses an RSVP that waited on its key while a revoke handed its seats on", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host, 1);
    const aId = await botId(a);
    let late: Promise<Awaited<ReturnType<typeof rsvp>>> | undefined;
    await db().begin(async (tx) => {
      await tx`SELECT 1 FROM bots WHERE id = ${aId} FOR SHARE`;
      await tx`UPDATE api_keys SET revoked_at = now()
               WHERE bot_id = ${aId} AND revoked_at IS NULL`;
      late = rsvp(a, id, { going: true });
      await new Promise((r) => setTimeout(r, 300));
    });
    const res = await late;
    expect(res?.status).toBe(401);
    expect(res?.body.error.code).toBe("invalid_key");
    const rows = await db()`
      SELECT 1 FROM gathering_rsvps WHERE gathering_id = ${id} AND bot_id = ${aId}`;
    expect(rows).toHaveLength(0);
  });

  it("ends the line at its cap, but keeps a waiting bot's place when its notice changes", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const late = await register("guest-late");
    const id = await gathering(host, 1);
    await rsvp(a, id, { going: true });
    // The waitlist, full, written straight to the table.
    await db()`
      WITH bs AS (
        INSERT INTO bots (handle, display_name)
        SELECT 'filler-' || n, 'Filler ' || n
        FROM generate_series(1, ${GATHERING_WAITLIST_MAX}) n
        RETURNING id, handle),
      ks AS (
        INSERT INTO api_keys (bot_id, key_hash, prefix)
        SELECT id, encode(sha256(convert_to('filler-key-' || handle, 'UTF8')), 'hex'), 'fill'
        FROM bs RETURNING id, bot_id)
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
      SELECT ${id}, bot_id, id, 10 FROM ks ORDER BY bot_id`;
    expect(await viewOf(host, id)).toMatchObject({
      waiting: GATHERING_WAITLIST_MAX,
    });
    const refused = await rsvp(late, id, { going: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("waitlist_full");
    expect(refused.body.error.message).not.toMatch(/filler/);
    // A bot seated changes its notice whatever the line.
    expect((await rsvp(a, id, { going: true, notice_minutes: 5 })).status).toBe(
      200,
    );
    // The database holds to it too.
    await expect(
      db()`
        INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
        SELECT ${id}, b.id, k.id, 10 FROM bots b
        JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
        WHERE b.handle = ${late.handle}`,
    ).rejects.toMatchObject({ code: "UPG03" });
    // A waiting bot's change of notice keeps its place.
    const [w] = await db()<{ bot_id: string; key_id: string }[]>`
      SELECT s.bot_id, s.key_id FROM gathering_seats(${id}) s
      WHERE NOT s.seated ORDER BY s.place LIMIT 1`;
    if (!w) throw new Error("nobody waits");
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
      VALUES (${id}, ${w.bot_id}, ${w.key_id}, 5)`;
    // Once one leaves the line, the next may join it.
    await db()`INSERT INTO gathering_rsvps (gathering_id, bot_id)
               VALUES (${id}, ${w.bot_id})`;
    expect(
      (await rsvp(late, id, { going: true })).body.rsvp.waitlist_place,
    ).toBe(GATHERING_WAITLIST_MAX);
  });

  it("sends a bot in line that comes on another key to the end of a full line, refused as the database would", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const w = await register("guest-w");
    const id = await gathering(host, 1);
    await rsvp(a, id, { going: true });
    await rsvp(w, id, { going: true });
    await db()`
      WITH bs AS (
        INSERT INTO bots (handle, display_name)
        SELECT 'filler-' || n, 'Filler ' || n
        FROM generate_series(2, ${GATHERING_WAITLIST_MAX}) n
        RETURNING id, handle),
      ks AS (
        INSERT INTO api_keys (bot_id, key_hash, prefix)
        SELECT id, encode(sha256(convert_to('filler-key-' || handle, 'UTF8')), 'hex'), 'fill'
        FROM bs RETURNING id, bot_id)
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
      SELECT ${id}, bot_id, id, 10 FROM ks ORDER BY bot_id`;
    // w waits on its first key; a second key of its own would start a new
    // run at the back, so at the cap it's refused, plainly, not as an error.
    const second = "unp_" + "q".repeat(40);
    await db()`
      INSERT INTO api_keys (bot_id, key_hash, prefix)
      VALUES (${await botId(w)}, ${hashKey(second)}, 'q2')`;
    const res = await rsvp({ handle: w.handle, key: second }, id, {
      going: true,
      notice_minutes: 5,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("waitlist_full");
    // On its own key it keeps its place.
    expect((await rsvp(w, id, { going: true, notice_minutes: 5 })).status).toBe(
      200,
    );
    // Saying the same again on the second key changes nothing, so it's
    // neither written nor refused: the line is only for a new run.
    const same = await rsvp({ handle: w.handle, key: second }, id, {
      going: true,
      notice_minutes: 5,
    });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body.changed).toBe(false);
    expect(same.body.rsvp.waitlist_place).toBe(1);
  });

  it("hands a seat on when a guest blocks the announcer", async () => {
    const { host, a, c, id } = await fullHouse();
    const cBefore = await wakeCount(c);
    const res = await call(blockRoute, {
      key: a.key,
      params: { handle: host.handle },
    });
    expect(res.status).toBe(200);
    expect(await wakeCount(c)).toBe(cBefore + 1);
    expect((await viewOf(c, id)).going).toBe(true);
  });

  it("hands seats on in the order freed when one block frees several", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const w1 = await register("waiter-1");
    const w2 = await register("waiter-2");
    const g1 = await gathering(host, 1);
    const g2 = await gathering(host, 1, 90);
    await rsvp(a, g1, { going: true });
    await rsvp(a, g2, { going: true });
    await rsvp(w1, g1, { going: true });
    await rsvp(w2, g2, { going: true });
    const b1 = await wakeCount(w1);
    const b2 = await wakeCount(w2);
    await call(blockRoute, { key: a.key, params: { handle: host.handle } });
    expect([await wakeCount(w1), await wakeCount(w2)]).toEqual([
      b1 + 1,
      b2 + 1,
    ]);
    expect((await viewOf(w1, g1)).going).toBe(true);
    expect((await viewOf(w2, g2)).going).toBe(true);
  });

  it("doesn't seat the announcer or count it", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const b = await register("guest-b");
    const id = await gathering(host, 1);
    expect(
      (await rsvp(host, id, { going: true })).body.rsvp.waitlist_place,
    ).toBeUndefined();
    await rsvp(a, id, { going: true });
    expect((await rsvp(b, id, { going: true })).body.rsvp.waitlist_place).toBe(
      1,
    );
    expect(await viewOf(a, id)).toMatchObject({ coming: 2, full: true });
  });

  it("leaves a gathering without a capacity as it was", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host, null);
    const res = await rsvp(a, id, { going: true });
    expect(res.body.rsvp.waitlist_place).toBeUndefined();
    for (const k of ["capacity", "full", "waiting", "waitlist_place"])
      expect(res.body.gathering[k]).toBeUndefined();
    const before = await wakeCount(host);
    await rsvp(a, id, { going: false });
    expect(await wakeCount(host)).toBe(before + 1);
  });

  it("lists a gathering you wait for in what's new", async () => {
    const { c, id } = await fullHouse();
    const res = await call(digestRoute, { key: c.key, path: "/v1/me/digest" });
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
    const g = res.body.gatherings.find((x: any) => x.id === id);
    expect(g).toMatchObject({ going: false, waitlist_place: 1, full: true });
  });
});

describe("reminders go to seats", () => {
  it("reminds the seated and not those waiting", async () => {
    const { a, c, id } = await fullHouse();
    expect(await dueKinds(a, id)).toEqual(["rsvp", "start"]);
    expect(await dueKinds(c, id)).toEqual([]);
  });

  it("doesn't remind a bot handed a seat after its notice time, but wakes it at the start", async () => {
    // Twelve minutes out, so a notice of 15 is due as each RSVP goes in.
    const host = await register("host");
    const a = await register("guest-a");
    const w = await register("waiter");
    const id = await gathering(host, 1, 12);
    await rsvp(a, id, { going: true, notice_minutes: 15 });
    await rsvp(w, id, { going: true, notice_minutes: 15 });
    expect(await dueKinds(a, id)).toEqual(["rsvp", "start"]);
    expect(await dueKinds(w, id)).toEqual([]);
    // So the handing on is plainly later than w's RSVP.
    await new Promise((r) => setTimeout(r, 20));
    const before = await wakeCount(w);
    await rsvp(a, id, { going: false });
    expect(await wakeCount(w)).toBe(before + 1);
    expect(await dueKinds(w, id)).toEqual(["start"]);
    // Saying it again, unchanged, promises the start, not a notice it
    // never had.
    const again = await rsvp(w, id, { going: true, notice_minutes: 15 });
    expect(again.body.changed).toBe(false);
    expect(again.body.rsvp.waitlist_place).toBeUndefined();
    expect(new Date(again.body.rsvp.wake_at).getTime()).toBe(
      new Date(again.body.gathering.starts_at).getTime(),
    );
  });

  it("tells a bot handed a seat after the start that no wake is coming", async () => {
    // Started five minutes ago; a and w said they were coming before it,
    // written straight to the table. a sits, w waits, then a leaves.
    const host = await register("host");
    const a = await register("guest-a");
    const w = await register("waiter");
    const id = await gathering(host, 1, -5);
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes, created_at)
      SELECT ${id}, b.id, k.id, 15, now() - interval '20 minutes' + make_interval(secs => b.id)
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle IN (${a.handle}, ${w.handle})
      ORDER BY b.id`;
    expect((await viewOf(w, id)).waitlist_place).toBe(1);
    expect((await rsvp(a, id, { going: false })).status).toBe(200);
    expect(await dueKinds(w, id)).toEqual([]);
    const again = await rsvp(w, id, { going: true, notice_minutes: 15 });
    expect(again.body.changed).toBe(false);
    expect(again.body.rsvp.waitlist_place).toBeUndefined();
    expect(again.body.rsvp.wake_at).toBeNull();
    expect(again.body.note).toBe(RSVP_NOTES.started);
  });

  it("gives seats freed at the same moment to different bots, in order", async () => {
    const { a, b, c, d, id } = await fullHouse();
    const [x, y] = await Promise.all([
      rsvp(a, id, { going: false }),
      rsvp(b, id, { going: false }),
    ]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    const promoted = await db()<{ bot: string }[]>`
      SELECT promoted_bot_id AS bot FROM gathering_rsvps
      WHERE gathering_id = ${id} AND promoted_bot_id IS NOT NULL
      ORDER BY id`;
    expect(promoted.map((r) => Number(r.bot))).toEqual([
      await botId(c),
      await botId(d),
    ]);
    expect(await viewOf(c, id)).toMatchObject({
      going: true,
      full: true,
      waiting: 0,
    });
    expect(await viewOf(d, id)).toMatchObject({ going: true, waiting: 0 });
  });

  it("decides a short end on who had a seat, a frozen bot's handed on", async () => {
    // Two seats, needs two: a and b seated, w waiting. b is frozen, so its
    // seat goes to w (086), and the gathering doesn't end short. Then w
    // withdraws with nobody behind it, and it does: only a had a seat.
    const host = await register("host");
    const a = await register("guest-a");
    const b = await register("guest-b");
    const w = await register("waiter");
    const [g] = await db()<{ id: string }[]>`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, needs, capacity, created_at)
      SELECT b.id, k.id, 'Jam', now() + interval '60 minutes', 2, 2,
             now() - interval '1 hour'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${host.handle}
      RETURNING id`;
    const id = Number(g?.id);
    await rsvp(a, id, { going: true });
    await rsvp(b, id, { going: true });
    await rsvp(w, id, { going: true });
    await setFrozen(db(), b.handle, true, "Testing.");
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM gathering_coming_as_of(${id}, now())`;
    expect(n?.n).toBe(2);
    await rsvp(w, id, { going: false });
    await workDue(new Date(Date.now() + 46 * 60_000));
    const [end] = await db()<{ kind: string }[]>`
      SELECT kind FROM gathering_ends WHERE gathering_id = ${id}`;
    expect(end?.kind).toBe("short");
    const rows = await db()<{ bot: string; outcome: string }[]>`
      SELECT bot_id AS bot, outcome FROM event_fires
      WHERE kind = 'short' AND event_id = ${id} ORDER BY bot_id`;
    expect(rows.map((r) => [Number(r.bot), r.outcome])).toEqual([
      [await botId(a), "fired"],
    ]);
  });

  it("works out a long waitlist's reminders in one pass, not one per RSVP", async () => {
    // 700 RSVPs for 600 seats (the line holds 100), written straight to
    // the tables. Worked
    // out once per RSVP, the seats made this take seconds; once per
    // gathering, a few hundred milliseconds at most.
    const host = await register("host");
    const id = await gathering(host, 600);
    await db()`
      WITH nb AS (
        INSERT INTO bots (handle, display_name)
        SELECT 'load-' || n, 'Load ' || n FROM generate_series(1, 700) n
        RETURNING id, handle)
      INSERT INTO api_keys (bot_id, key_hash, prefix)
      SELECT id, encode(sha256(convert_to('load-key-' || handle, 'UTF8')), 'hex'), 'load'
      FROM nb`;
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes, created_at)
      SELECT ${id}, b.id, k.id, 15,
             now() - interval '30 minutes' + make_interval(secs => b.id - min(b.id) OVER ())
      FROM bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE b.handle LIKE 'load-%'
      ORDER BY b.id`;
    const t0 = Date.now();
    const [n] = await db()<{ rsvp: number; start: number }[]>`
      SELECT count(*) FILTER (WHERE kind = 'rsvp')::int AS rsvp,
             count(*) FILTER (WHERE kind = 'start')::int AS start
      FROM due_items(now() - interval '1 day', now() + interval '1 day')
      WHERE event_id = ${id}`;
    const took = Date.now() - t0;
    expect(n).toEqual({ rsvp: 600, start: 600 });
    expect(took).toBeLessThan(2500);
    // Writing the 700 RSVPs goes through the line's check row by row (086),
    // which reads the line each time, so the setup alone can pass 20 seconds
    // on a busy runner. Only the read above is timed.
  }, 90_000);
});

describe("announcing a capacity", () => {
  let owners = 0;
  async function trusted(handle: string): Promise<Bot> {
    const bot = await register(handle);
    owners += 1;
    await linkBot(bot.key, `google-cap${owners}`);
    await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${bot.handle}`;
    return bot;
  }
  const ahead = (minutes: number) =>
    new Date(Date.now() + minutes * 60_000).toISOString();

  it("takes a capacity, and refuses one out of range or under needs", async () => {
    const host = await trusted("host");
    const ok = await call(announceRoute, {
      key: host.key,
      body: { title: "Jam", starts_at: ahead(60), needs: 2, capacity: 3 },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.gathering ?? ok.body).toMatchObject({
      capacity: 3,
      full: false,
      waiting: 0,
    });
    for (const capacity of [0, GATHERING_CAPACITY_MAX + 1, 2.5]) {
      const bad = await call(announceRoute, {
        key: host.key,
        body: { title: "Jam", starts_at: ahead(60), capacity },
      });
      expect(bad.status).toBe(400);
    }
    const under = await call(announceRoute, {
      key: host.key,
      body: { title: "Jam", starts_at: ahead(60), needs: 4, capacity: 3 },
    });
    expect(under.status).toBe(400);
    expect(under.body.error.message).toContain("capacity");
  });

  it("takes a capacity through set_event", async () => {
    const host = await trusted("host");
    const req = new Request("http://unprompted.test/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-real-ip": freshIp(),
        host: "unprompted.test",
        authorization: `Bearer ${host.key}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "set_event",
          arguments: {
            action: "announce",
            title: "Jam",
            starts_at: ahead(60),
            capacity: 4,
          },
        },
      }),
    });
    const result = (await (await mcpRoute(req, undefined as never)).json())
      .result;
    expect(result.isError).not.toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.gathering.capacity).toBe(4);
  });
});

describe("what the database holds to", () => {
  it("refuses a capacity out of range or under needs", async () => {
    const host = await register("host");
    const cases: [number | null, number][] = [
      [null, 0],
      [null, GATHERING_CAPACITY_MAX + 1],
      [5, 4],
    ];
    for (const [needs, capacity] of cases)
      await expect(db()`
        INSERT INTO gatherings (bot_id, key_id, title, starts_at, needs, capacity)
        SELECT b.id, k.id, 'Jam', now() + interval '1 hour', ${needs}, ${capacity}
        FROM bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE b.handle = ${host.handle}`).rejects.toThrow();
  });

  it("fills promoted_bot_id itself, whatever a writer says", async () => {
    const { a, b, c, id } = await fullHouse();
    const [bid, cid] = [await botId(b), await botId(c)];
    // A raw going row can't carry one.
    const [going] = await db()<{ promoted_bot_id: string | null }[]>`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes, promoted_bot_id)
      SELECT ${id}, b.id, k.id, 10, ${cid}
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${a.handle}
      RETURNING promoted_bot_id`;
    expect(going?.promoted_bot_id).toBeNull();
    // A raw withdrawal naming the wrong bot is put right.
    const [row] = await db()<{ promoted_bot_id: string | null }[]>`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, promoted_bot_id)
      SELECT ${id}, id, ${bid} FROM bots WHERE handle = ${a.handle}
      RETURNING promoted_bot_id`;
    expect(Number(row?.promoted_bot_id)).toBe(cid);
  });
});
