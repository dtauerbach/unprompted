import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { POST as revokeRoute } from "@/app/v1/me/keys/revoke/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { setFrozen, setGates } from "@/lib/admin";
import { db, type Tx } from "@/lib/db";
import { soonestDue, workDue } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { RSVP_NOTES } from "@/lib/gatherings";
import { call, freshIp, linkBot, register, resetDb } from "./helpers";

// A gathering that meets more than once (EV4, 087_gathering_series.sql).
// The announcer says how far apart (daily or weekly) and how many times;
// each meeting is a gathering of its own, made once it's within the
// announcement window, at the announcement or by the clock. One RSVP with
// series stands for every meeting, made and to come, until the bot steps
// out of the series, blocks its announcer, is frozen or loses its key.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

let owners = 0;
// A bot the default gate lets announce: claimed, and no longer new.
async function trusted(handle: string): Promise<Bot> {
  const bot = await register(handle);
  owners += 1;
  await linkBot(bot.key, `google-s${owners}`);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${bot.handle}`;
  return bot;
}

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const announce = (b: Bot, body: unknown) =>
  call(announceRoute, { key: b.key, body });
const rsvp = (b: Bot, id: number, body: unknown) =>
  call(rsvpRoute, {
    key: b.key,
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/rsvp`,
  });
const cancel = (b: Bot, id: number, body?: unknown) =>
  call(cancelRoute, {
    key: b.key,
    method: "POST",
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/cancel`,
  });
const block = (b: Bot, handle: string) =>
  call(blockRoute, { key: b.key, params: { handle } });
const unblock = (b: Bot, handle: string) =>
  call(unblockRoute, { key: b.key, method: "DELETE", params: { handle } });

async function botId(b: Bot): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${b.handle}`;
  return Number(r?.id);
}

// The meetings made so far, by meeting number.
async function meetings(series: number): Promise<Map<number, number>> {
  const rows = await db()<{ id: string; occurrence: number }[]>`
    SELECT id, occurrence FROM gatherings WHERE series_id = ${series}
    ORDER BY occurrence`;
  return new Map(rows.map((r) => [r.occurrence, Number(r.id)]));
}

// Whether bot b's RSVP in force to gathering g says it's coming.
async function coming(b: Bot, g: number): Promise<boolean> {
  const [r] = await db()<{ going: boolean }[]>`
    SELECT x.key_id IS NOT NULL AS going FROM gathering_rsvps x
    JOIN bots bb ON bb.id = x.bot_id
    WHERE x.gathering_id = ${g} AND bb.handle = ${b.handle}
    ORDER BY x.id DESC LIMIT 1`;
  return r?.going ?? false;
}

// A series written straight to the table as if announced six days ago,
// daily, starting an hour after then: its first six meetings have passed
// unmade (as on a quiet site), and meetings 7 to 12 are within the window.
async function oldSeries(host: Bot, capacity: number | null = null) {
  const [s] = await db()<{ id: string }[]>`
    INSERT INTO gathering_series
      (bot_id, key_id, title, starts_at, repeat, times, capacity, created_at)
    SELECT b.id, k.id, 'Standup', now() - interval '6 days' + interval '1 hour',
           'daily', 12, ${capacity}, now() - interval '6 days'
    FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
    WHERE b.handle = ${host.handle}
    RETURNING id`;
  return Number(s?.id);
}

// The meetings the clock skipped for good, and why.
async function skipsOf(series: number) {
  return db()<{ occurrence: number; reason: string }[]>`
    SELECT occurrence, reason FROM gathering_series_skips
    WHERE series_id = ${series} ORDER BY occurrence`;
}

// When the clock will next try a series' meeting still to make, in ms.
async function nextTry(series: number): Promise<number> {
  const [r] = await db()<{ at: Date | null }[]>`
    SELECT min(try_at) AS at FROM gathering_series_pending(${series})`;
  return r?.at ? r.at.getTime() : Number.POSITIVE_INFINITY;
}

// Uses n of a bot's daily gatherings and meetings, as announcing would.
async function useMeetings(b: Bot, n: number) {
  await db()`
    INSERT INTO rate_limits (bucket, window_start, count)
    VALUES (${`gathering-meeting:day:${await botId(b)}`},
            to_timestamp(floor(extract(epoch FROM now()) / 86400) * 86400), ${n})`;
}

// How many of its hour's RSVP changes a bot has used.
async function rsvpUses(b: Bot): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
    WHERE bucket = ${`rsvp:${await botId(b)}`}`;
  return r?.n ?? 0;
}

// A standing RSVP written straight to the table.
async function stand(b: Bot, series: number, notice = 10) {
  await db()`
    INSERT INTO gathering_series_rsvps (series_id, bot_id, key_id, notice_minutes)
    SELECT ${series}, b.id, k.id, ${notice}
    FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
    WHERE b.handle = ${b.handle}`;
}

describe("announcing a series", () => {
  it("makes each meeting already within the window, as a gathering of its own", async () => {
    const host = await trusted("host");
    const res = await announce(host, {
      title: "Morning standup",
      starts_at: ahead(60),
      repeat: "daily",
      times: 3,
      capacity: 4,
    });
    expect(res.status).toBe(201);
    const g = res.body.gathering;
    expect(g.series).toMatchObject({ meeting: 1, of: 3, repeat: "daily" });
    expect(g.series.standing).toBeUndefined();
    const made = await meetings(g.series.id);
    expect([...made.keys()]).toEqual([1, 2, 3]);
    expect(made.get(1)).toBe(g.id);
    // A day apart to the hour, each with the series' title and capacity.
    const rows = await db()<
      { starts_at: Date; title: string; capacity: number }[]
    >`SELECT starts_at, title, capacity FROM gatherings
      WHERE series_id = ${g.series.id} ORDER BY occurrence`;
    expect(rows[1]!.starts_at.getTime() - rows[0]!.starts_at.getTime()).toBe(
      24 * 3600_000,
    );
    expect(rows.every((r) => r.title === "Morning standup")).toBe(true);
    expect(rows.every((r) => r.capacity === 4)).toBe(true);
    // Listed as three gatherings, each saying which meeting it is.
    const list = await call(listRoute, { path: "/v1/gatherings" });
    expect(
      list.body.gatherings.map(
        (x: { series: { meeting: number } }) => x.series.meeting,
      ),
    ).toEqual([1, 2, 3]);
    const [log] = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.announce'`;
    expect(log?.detail).toMatchObject({
      series: g.series.id,
      repeat: "daily",
      times: 3,
    });
    const makes = await db()`
      SELECT 1 FROM action_log WHERE action = 'gathering.series_make'`;
    expect(makes.length).toBe(2);
  });

  it("gives every meeting the series' length, at the announcement and from the clock", async () => {
    const host = await trusted("host");
    const res = await announce(host, {
      title: "Long jam",
      starts_at: ahead(60),
      repeat: "daily",
      times: 3,
      lasts_minutes: 180,
    });
    expect(res.status).toBe(201);
    const sid = res.body.gathering.series.id as number;
    expect([...(await meetings(sid)).keys()]).toEqual([1, 2, 3]);
    // Each meeting says when it ends, as a long gathering of its own does.
    const list = await call(listRoute, { path: "/v1/gatherings" });
    expect(list.body.gatherings).toHaveLength(3);
    for (const g of list.body.gatherings as {
      starts_at: string;
      ends_at: string;
    }[])
      expect(
        new Date(g.ends_at).getTime() - new Date(g.starts_at).getTime(),
      ).toBe(180 * 60_000);
    // The clock writes the same length into a meeting it makes itself.
    const other = await trusted("other");
    const [s2] = await db()<{ id: string }[]>`
      INSERT INTO gathering_series
        (bot_id, key_id, title, starts_at, repeat, times, lasts_minutes, created_at)
      SELECT b.id, k.id, 'Standup', now() - interval '6 days' + interval '1 hour',
             'daily', 12, 240, now() - interval '6 days'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${other.handle}
      RETURNING id`;
    await workDue();
    const rows = await db()<{ lasts_minutes: number }[]>`
      SELECT lasts_minutes FROM gatherings WHERE series_id = ${Number(s2?.id)}`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.lasts_minutes === 240)).toBe(true);
  });

  it("makes a weekly series' later meetings only as they come within the window", async () => {
    const host = await trusted("host");
    const res = await announce(host, {
      title: "Weekly jam",
      starts_at: ahead(60),
      repeat: "weekly",
      times: 4,
    });
    expect(res.status).toBe(201);
    const sid = res.body.gathering.series.id;
    expect([...(await meetings(sid)).keys()]).toEqual([1]);
    // The clock knows when the next one is due to be made.
    const [p] = await db()<{ make_at: Date }[]>`
      SELECT make_at FROM gathering_series_pending()
      WHERE series_id = ${sid} ORDER BY occurrence LIMIT 1`;
    const { next } = await soonestDue(db());
    expect(next?.getTime()).toBeLessThanOrEqual(p!.make_at.getTime());
    // And a run now makes nothing early.
    expect((await workDue()).made).toBe(0);
    expect([...(await meetings(sid)).keys()]).toEqual([1]);
  });

  it("counts once against the daily limit on announcing", async () => {
    const host = await trusted("host");
    for (let i = 0; i < 3; i++)
      expect(
        (
          await announce(host, {
            title: `Series ${i}`,
            starts_at: ahead(60),
            repeat: "daily",
            times: 12,
          })
        ).status,
      ).toBe(201);
    expect(
      (await announce(host, { title: "Once", starts_at: ahead(60) })).status,
    ).toBe(201);
    const fifth = await announce(host, {
      title: "One more",
      starts_at: ahead(60),
    });
    expect(fifth.status).toBe(429);
  });

  it("lets a bot run three series at once, and another once one is cancelled", async () => {
    const host = await trusted("host");
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await announce(host, {
        title: `Series ${i}`,
        starts_at: ahead(60),
        repeat: "weekly",
        times: 2,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      ids.push(res.body.gathering.id as number);
    }
    const fourth = await announce(host, {
      title: "A fourth",
      starts_at: ahead(60),
      repeat: "daily",
      times: 2,
    });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe("too_many_series");
    // Refused before anything was written: no series, no meeting.
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM gathering_series s JOIN bots b ON b.id = s.bot_id
      WHERE b.handle = ${host.handle}`;
    expect(n?.n).toBe(3);
    // A gathering that meets once isn't a series.
    expect(
      (await announce(host, { title: "Once", starts_at: ahead(60) })).status,
    ).toBe(201);
    expect((await cancel(host, ids[0]!, { series: true })).status).toBe(200);
    // Cancelling freed one, but the day's four announcements are spent.
    expect(
      (
        await announce(host, {
          title: "A fourth",
          starts_at: ahead(60),
          repeat: "daily",
          times: 2,
        })
      ).status,
    ).toBe(429);
  });

  it("refuses repeat without times, times out of bounds, and a bad repeat", async () => {
    const host = await trusted("host");
    const base = { title: "Jam", starts_at: ahead(60) };
    for (const extra of [
      { repeat: "daily" },
      { times: 3 },
      { repeat: "daily", times: 1 },
      { repeat: "daily", times: 13 },
      { repeat: "daily", times: 2.5 },
      { repeat: "hourly", times: 3 },
    ]) {
      const res = await announce(host, { ...base, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM gathering_series`;
    expect(n?.n).toBe(0);
  });
});

describe("the clock", () => {
  it("makes meetings that came within the window, never ones whose time passed", async () => {
    const host = await trusted("host");
    const sid = await oldSeries(host);
    const r = await workDue();
    expect(r.made).toBe(6);
    expect([...(await meetings(sid)).keys()]).toEqual([7, 8, 9, 10, 11, 12]);
    // Once made, never again.
    expect((await workDue()).made).toBe(0);
  });

  it("copies standing RSVPs onto each meeting it makes, oldest first", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const b = await trusted("bravo");
    const c = await trusted("charlie");
    const sid = await oldSeries(host, 2);
    await stand(b, sid);
    await stand(a, sid, 5);
    await stand(c, sid);
    await workDue();
    const m7 = (await meetings(sid)).get(7)!;
    // Seats in the order they stood: bravo, then alpha; charlie waits.
    const seats = await db()<
      { bot_id: string; seated: boolean; notice_minutes: number }[]
    >`SELECT bot_id, seated, notice_minutes FROM gathering_seats(${m7})
      ORDER BY place`;
    expect(seats.map((s) => Number(s.bot_id))).toEqual([
      await botId(b),
      await botId(a),
      await botId(c),
    ]);
    expect(seats.map((s) => s.seated)).toEqual([true, true, false]);
    expect(seats[1]?.notice_minutes).toBe(5);
    // Their reminders are items like any RSVP's.
    const items = await db()`
      SELECT 1 FROM due_items(now() - interval '1 day', 'infinity')
      WHERE kind = 'rsvp' AND event_id = ${m7}`;
    expect(items.length).toBe(2);
  });

  it("holds meetings while its announcer is frozen, skipping only one at its last try", async () => {
    const host = await trusted("host");
    const sid = await oldSeries(host);
    await setFrozen(db(), host.handle, true, "Test.");
    expect((await workDue()).made).toBe(0);
    // Meeting 7 starts within the hour: its last try, so it's skipped, once.
    // The rest are held, and tried again an hour on, not every minute.
    expect(await skipsOf(sid)).toEqual([{ occurrence: 7, reason: "frozen" }]);
    expect(await nextTry(sid)).toBeGreaterThan(Date.now() + 50 * 60_000);
    await setFrozen(db(), host.handle, false, "Test.");
    expect((await workDue()).made).toBe(5);
    expect([...(await meetings(sid)).keys()]).toEqual([8, 9, 10, 11, 12]);
    expect(await skipsOf(sid)).toEqual([{ occurrence: 7, reason: "frozen" }]);
  });

  it("skips a meeting while a moderator hides one of the series", async () => {
    const host = await trusted("host");
    const res = await announce(host, {
      title: "Jam",
      starts_at: ahead(60),
      repeat: "weekly",
      times: 2,
    });
    const g = res.body.gathering;
    await db()`
      INSERT INTO hidden_gatherings (gathering_id) VALUES (${g.id})`;
    const made = await db()<{ n: number }[]>`
      SELECT gathering_series_make(${g.series.id}) AS n`;
    expect(made[0]?.n).toBe(0);
    // Not yet due: nothing skipped either. The skip comes with its hour.
    const skips = await db()`
      SELECT 1 FROM gathering_series_skips WHERE series_id = ${g.series.id}`;
    expect(skips.length).toBe(0);
  });

  it("holds a made meeting to its series' words and time", async () => {
    const host = await trusted("host");
    const sid = await oldSeries(host);
    const bad = db()`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, series_id, occurrence)
      SELECT b.id, k.id, 'Something else',
             gathering_series_start(s.starts_at, s.repeat, 8), s.id, 8
      FROM gathering_series s JOIN bots b ON b.id = s.bot_id
      JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE s.id = ${sid}`;
    await expect(bad).rejects.toThrow(/isn't a meeting of series/);
  });
});

describe("RSVP with series", () => {
  async function weekly(host: Bot, times = 3) {
    const res = await announce(host, {
      title: "Jam",
      starts_at: ahead(60),
      repeat: "daily",
      times,
    });
    return res.body.gathering as { id: number; series: { id: number } };
  }

  it("says you're coming to every meeting made so far, and to each one made later", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const g = await weekly(host);
    const res = await rsvp(a, g.id, {
      going: true,
      series: true,
      notice_minutes: 5,
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.rsvp.series).toEqual({ standing: true, meetings: 2 });
    expect(res.body.gathering.series.standing).toBe(true);
    expect(res.body.note).toContain(RSVP_NOTES.series);
    for (const id of (await meetings(g.series.id)).values())
      expect(await coming(a, id)).toBe(true);
    // Saying it again unchanged writes nothing.
    const again = await rsvp(a, g.id, {
      going: true,
      series: true,
      notice_minutes: 5,
    });
    expect(again.body.changed).toBe(false);
    expect(again.body.rsvp.series).toEqual({ standing: true, meetings: 0 });
    const logs = await db()`
      SELECT 1 FROM action_log WHERE action = 'gathering.series_rsvp'`;
    expect(logs.length).toBe(1);
  });

  it("is copied onto a meeting the clock makes later", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const sid = await oldSeries(host);
    await workDue();
    const m7 = (await meetings(sid)).get(7)!;
    const res = await rsvp(a, m7, { going: true, series: true });
    expect(res.body.rsvp.series.meetings).toBe(5);
    // A series of more meetings: write one more straight in, as the clock
    // would, and see the copy.
    const [n] = await db()<{ n: number }[]>`
      SELECT gathering_series_copy(${sid}, ${m7}) AS n`;
    expect(n?.n).toBe(0);
  });

  it("leaves the others standing when you step out of one meeting alone", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const g = await weekly(host);
    await rsvp(a, g.id, { going: true, series: true });
    const m = await meetings(g.series.id);
    const out = await rsvp(a, m.get(2)!, { going: false });
    expect(out.status).toBe(200);
    expect(await coming(a, m.get(1)!)).toBe(true);
    expect(await coming(a, m.get(2)!)).toBe(false);
    expect(await coming(a, m.get(3)!)).toBe(true);
    expect(out.body.gathering.series.standing).toBe(true);
  });

  it("steps out of every meeting with going false and series, and no later one takes it", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const sid = await oldSeries(host);
    await workDue();
    const m = await meetings(sid);
    await rsvp(a, m.get(7)!, { going: true, series: true });
    const out = await rsvp(a, m.get(9)!, { going: false, series: true });
    expect(out.status).toBe(200);
    expect(out.body.rsvp.series).toEqual({ standing: false, meetings: 5 });
    expect(out.body.note).toContain(RSVP_NOTES.series_withdrawn);
    for (const id of m.values()) expect(await coming(a, id)).toBe(false);
    const standing = await db()`
      SELECT 1 FROM gathering_series_standing(${sid})`;
    expect(standing.length).toBe(0);
  });

  it("refuses series on a gathering that meets once, and on your own", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const once = await announce(host, { title: "Once", starts_at: ahead(60) });
    const r1 = await rsvp(a, once.body.gathering.id, {
      going: true,
      series: true,
    });
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe("not_a_series");
    const g = await weekly(host);
    const r2 = await rsvp(host, g.id, { going: true, series: true });
    expect(r2.status).toBe(400);
    const rows = await db()`SELECT 1 FROM gathering_series_rsvps`;
    expect(rows.length).toBe(0);
  });

  it("ends for good when you block the announcer", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const sid = await oldSeries(host);
    await stand(a, sid);
    expect((await block(a, host.handle)).status).toBeLessThan(300);
    expect((await unblock(a, host.handle)).status).toBeLessThan(300);
    await workDue();
    const m7 = (await meetings(sid)).get(7)!;
    expect(await coming(a, m7)).toBe(false);
  });

  it("ends with the key that said it, and with a freeze", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const b = await trusted("bravo");
    const sid = await oldSeries(host);
    await stand(a, sid);
    await stand(b, sid);
    expect(
      (await call(revokeRoute, { key: a.key, path: "/v1/me/keys/revoke" }))
        .status,
    ).toBe(200);
    await setFrozen(db(), b.handle, true, "Test.");
    const ends = await db()<{ released_by: string }[]>`
      SELECT released_by FROM gathering_series_rsvps
      WHERE released_by IS NOT NULL ORDER BY id`;
    expect(ends.map((e) => e.released_by)).toEqual(["key", "frozen"]);
    await setFrozen(db(), b.handle, false, "Test.");
    await workDue();
    const m7 = (await meetings(sid)).get(7)!;
    expect(await coming(b, m7)).toBe(false);
  });

  it("is refused by the database for the announcer itself", async () => {
    const host = await trusted("host");
    const sid = await oldSeries(host);
    await expect(stand(host, sid)).rejects.toMatchObject({ code: "UPG01" });
  });
});

// A transaction held open until release() is called, so another write can
// be started while it holds its locks.
function held(work: (tx: Tx) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let ready!: () => void;
  const started = new Promise<void>((r) => {
    ready = r;
  });
  const done = db().begin(async (tx) => {
    await work(tx);
    ready();
    await gate;
  });
  return { started, release, done };
}

// Whether n sessions are waiting on the transaction held open.
async function waiters(n: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    const [r] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity w
      WHERE w.wait_event_type = 'Lock' AND w.datname = current_database()
        AND EXISTS (SELECT 1 FROM pg_stat_activity h
                    WHERE h.pid = ANY (pg_blocking_pids(w.pid))
                      AND h.state = 'idle in transaction')`;
    if ((r?.n ?? 0) >= n) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}

// Whether a session is waiting on a lock right now.
async function someoneWaits(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    const [r] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity w
      WHERE w.wait_event_type = 'Lock' AND w.datname = current_database()
        -- Waiting on the transaction held open on purpose, idle meanwhile.
        AND EXISTS (SELECT 1 FROM pg_stat_activity h
                    WHERE h.pid = ANY (pg_blocking_pids(w.pid))
                      AND h.state = 'idle in transaction')`;
    if ((r?.n ?? 0) > 0) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}

let rpcId = 0;
async function tool(key: string, name: string, args: object) {
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

async function wakeOf(b: Bot): Promise<number> {
  const [r] = await db()<{ n: string }[]>`
    SELECT coalesce((SELECT w.count FROM wake_counters w WHERE w.bot_id = b.id), 0) AS n
    FROM bots b WHERE b.handle = ${b.handle}`;
  return Number(r?.n ?? 0);
}

describe("what can cross the clock making a meeting", () => {
  it("a block that comes while a meeting is made ends the RSVP copied onto it", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const sid = await oldSeries(host);
    await stand(a, sid);
    const make = held((tx) => tx`SELECT gathering_series_make(${sid})`);
    await make.started;
    const blocking = block(a, host.handle);
    expect(await someoneWaits()).toBe(true);
    make.release();
    await make.done;
    expect((await blocking).status).toBeLessThan(300);
    for (const id of (await meetings(sid)).values())
      expect(await coming(a, id)).toBe(false);
    expect(
      (await db()`SELECT 1 FROM gathering_series_standing(${sid})`).length,
    ).toBe(0);
  });

  it("a key revoked while a meeting is made gives up the seat copied onto it", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const b = await trusted("bravo");
    const sid = await oldSeries(host, 1);
    await stand(a, sid);
    await stand(b, sid);
    const make = held((tx) => tx`SELECT gathering_series_make(${sid})`);
    await make.started;
    const revoking = call(revokeRoute, {
      key: a.key,
      path: "/v1/me/keys/revoke",
    });
    expect(await someoneWaits()).toBe(true);
    make.release();
    await make.done;
    expect((await revoking).status).toBe(200);
    // Each meeting's seat went on to bravo, who was waiting.
    for (const id of (await meetings(sid)).values()) {
      const seats = await db()<{ bot_id: string; seated: boolean }[]>`
        SELECT bot_id, seated FROM gathering_seats(${id})`;
      expect(seats).toEqual([{ bot_id: String(await botId(b)), seated: true }]);
    }
  });

  it("a meeting made while a key is being revoked copies nothing onto the dead key", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const sid = await oldSeries(host);
    await stand(a, sid);
    const id = await botId(a);
    const revoke = held(
      (tx) =>
        tx`UPDATE api_keys SET revoked_at = now() WHERE bot_id = ${id} AND revoked_at IS NULL`,
    );
    await revoke.started;
    const run = workDue();
    expect(await someoneWaits()).toBe(true);
    revoke.release();
    await revoke.done;
    expect((await run).made).toBe(6);
    const copies = await db()`
      SELECT 1 FROM gathering_rsvps x JOIN gatherings g ON g.id = x.gathering_id
      WHERE g.series_id = ${sid} AND x.key_id IS NOT NULL`;
    expect(copies.length).toBe(0);
  });

  it("a freeze of the announcer that comes first is seen, and the meetings are skipped", async () => {
    const host = await trusted("host");
    const sid = await oldSeries(host);
    const id = await botId(host);
    const freeze = held(
      (tx) => tx`UPDATE bots SET frozen_at = now() WHERE id = ${id}`,
    );
    await freeze.started;
    const run = workDue();
    expect(await someoneWaits()).toBe(true);
    freeze.release();
    await freeze.done;
    expect((await run).made).toBe(0);
    expect(await skipsOf(sid)).toEqual([{ occurrence: 7, reason: "frozen" }]);
  });

  it("an announcement by the series' own bot crosses a run without deadlocking", async () => {
    const host = await trusted("host");
    const sid = await oldSeries(host);
    // The row both paths take: the announcer's own day of meetings. Held
    // open, so the two line up in the order that used to deadlock, the
    // announcement first.
    await useMeetings(host, 0);
    const bucket = `gathering-meeting:day:${await botId(host)}`;
    const hold = held(
      (tx) => tx`UPDATE rate_limits SET count = count WHERE bucket = ${bucket}`,
    );
    await hold.started;
    const said = announce(host, { title: "One off", starts_at: ahead(60) });
    expect(await someoneWaits()).toBe(true);
    // The run queues behind it for the same row, which it takes before the
    // site-wide cap, as the announcement does. Taken the other way round,
    // whichever got the site-wide row first would wait on the other for
    // this one and Postgres would kill one of them.
    const run = workDue();
    expect(await waiters(2)).toBe(true);
    hold.release();
    await hold.done;
    const res = await said;
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await run).made).toBe(6);
    expect(await skipsOf(sid)).toEqual([]);
  });
});

describe("what holds a meeting back", () => {
  it("holds meetings while the announcer is silenced, or has no live key, and makes them once that lifts", async () => {
    const host = await trusted("host");
    const sid = await oldSeries(host);
    await db()`UPDATE bots SET silenced_until = now() + interval '1 hour'
      WHERE handle = ${host.handle}`;
    expect((await workDue()).made).toBe(0);
    const host2 = await trusted("host2");
    const sid2 = await oldSeries(host2);
    await db()`UPDATE api_keys SET revoked_at = now()
      WHERE bot_id = ${await botId(host2)}`;
    expect((await workDue()).made).toBe(0);
    expect(await skipsOf(sid)).toEqual([{ occurrence: 7, reason: "silenced" }]);
    expect(await skipsOf(sid2)).toEqual([{ occurrence: 7, reason: "key" }]);
    await db()`UPDATE bots SET silenced_until = NULL WHERE handle = ${host.handle}`;
    expect((await workDue()).made).toBe(5);
    expect((await meetings(sid)).size).toBe(5);
    expect((await meetings(sid2)).size).toBe(0);
  });

  it("holds meetings the announcer's gate holds back, judged when each is made", async () => {
    const host = await trusted("host");
    const sid = await oldSeries(host);
    await setGates(
      db(),
      { announce: [{ signal: "claimed", is: false }] },
      "Test.",
    );
    expect((await workDue()).made).toBe(0);
    expect(await skipsOf(sid)).toEqual([{ occurrence: 7, reason: "gate" }]);
    await setGates(db(), {}, "Test.");
    expect((await workDue()).made).toBe(5);
  });

  it("counts each meeting against the site-wide cap, at the announcement and on the clock", async () => {
    await db()`
      INSERT INTO settings (key, value)
      VALUES ('anti_abuse_limits', ${JSON.stringify({ gathering_global: 4 })}::text::jsonb)`;
    const host = await trusted("host");
    // Five meetings within the window at once: more than the cap holds.
    const over = await announce(host, {
      title: "Daily",
      starts_at: ahead(60),
      repeat: "daily",
      times: 5,
    });
    expect(over.status).toBe(429);
    expect((await db()`SELECT 1 FROM gathering_series`).length).toBe(0);
    expect((await db()`SELECT 1 FROM gatherings`).length).toBe(0);
    // Three fit; one use is left for the clock.
    const fits = await announce(host, {
      title: "Daily",
      starts_at: ahead(60),
      repeat: "daily",
      times: 3,
    });
    expect(fits.status).toBe(201);
    const sid = await oldSeries(await trusted("host2"));
    const r = await workDue();
    expect(r.made).toBe(1);
    // The rest wait for room rather than being dropped: no skip while
    // they're more than 75 minutes off.
    expect([...(await meetings(sid)).keys()]).toEqual([7]);
    expect(await skipsOf(sid)).toEqual([]);
    expect(await nextTry(sid)).toBeGreaterThan(Date.now() + 50 * 60_000);
    // A single gathering is refused now too: the day's cap is spent.
    expect(
      (await announce(host, { title: "Once", starts_at: ahead(60) })).status,
    ).toBe(429);
    // Room again (another day, as far as the cap knows): the held ones are
    // made at the next try, as many as the cap holds, and the last still waits.
    await db()`DELETE FROM rate_limits WHERE bucket = 'gathering:all'`;
    expect((await workDue()).made).toBe(4);
    expect([...(await meetings(sid)).keys()]).toEqual([7, 8, 9, 10, 11]);
    expect(await skipsOf(sid)).toEqual([]);
  });

  it("counts each meeting against its bot's own day, so cancelling and announcing again runs out", async () => {
    const host = await trusted("host");
    // A day of announcing nearly spent: one gathering left today.
    await useMeetings(host, 23);
    const over = await announce(host, {
      title: "Daily",
      starts_at: ahead(60),
      repeat: "daily",
      times: 2,
    });
    expect(over.status).toBe(429);
    expect((await db()`SELECT 1 FROM gatherings`).length).toBe(0);
    const host2 = await trusted("host2");
    const sid = await oldSeries(host2);
    await useMeetings(host2, 22);
    // Two of meetings 7 to 12 fit host2's day; the rest are held for it,
    // and another bot's series is made in full meanwhile.
    const sid3 = await oldSeries(await trusted("host3"));
    expect((await workDue()).made).toBe(8);
    expect([...(await meetings(sid)).keys()]).toEqual([7, 8]);
    expect((await meetings(sid3)).size).toBe(6);
    expect(await skipsOf(sid)).toEqual([]);
  });
});

describe("a standing RSVP's details", () => {
  async function daily(host: Bot, capacity?: number) {
    const res = await announce(host, {
      title: "Jam",
      starts_at: ahead(60),
      repeat: "daily",
      times: 3,
      ...(capacity ? { capacity } : {}),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.gathering as { id: number; series: { id: number } };
  }

  async function noticeOf(b: Bot, g: number): Promise<number | null> {
    const [r] = await db()<{ n: number | null }[]>`
      SELECT x.notice_minutes AS n FROM gathering_rsvps x
      JOIN bots bb ON bb.id = x.bot_id
      WHERE x.gathering_id = ${g} AND bb.handle = ${b.handle}
      ORDER BY x.id DESC LIMIT 1`;
    return r?.n ?? null;
  }

  it("keeps a meeting you stepped out of alone out when the series changes, until you name it", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const g = await daily(host);
    const m = await meetings(g.series.id);
    await rsvp(a, g.id, { going: true, series: true, notice_minutes: 5 });
    await rsvp(a, m.get(3)!, { going: false });
    const r = await rsvp(a, g.id, {
      going: true,
      series: true,
      notice_minutes: 15,
    });
    expect(r.body.rsvp.series.meetings).toBe(1);
    expect(await noticeOf(a, m.get(2)!)).toBe(15);
    expect(await coming(a, m.get(3)!)).toBe(false);
    // By name, it's back.
    await rsvp(a, m.get(3)!, { going: true });
    expect(await coming(a, m.get(3)!)).toBe(true);
    // After stepping out of the whole series and back in, every meeting.
    await rsvp(a, g.id, { going: false, series: true });
    await rsvp(a, m.get(3)!, { going: false });
    await rsvp(a, g.id, { going: false, series: true });
    const back = await rsvp(a, g.id, { going: true, series: true });
    expect(back.status).toBe(200);
    for (const id of m.values()) expect(await coming(a, id)).toBe(true);
  });

  it("writes a meeting that passed the bot over when it says the series again, counting each", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const sid = await oldSeries(host);
    await stand(a, sid);
    // Silenced while the clock copies: passed over for every meeting.
    await db()`UPDATE bots SET silenced_until = now() + interval '1 hour'
      WHERE handle = ${a.handle}`;
    expect((await workDue()).made).toBe(6);
    const m = await meetings(sid);
    for (const id of m.values()) expect(await coming(a, id)).toBe(false);
    // The lists still say it stands, so saying so again repairs it.
    await db()`UPDATE bots SET silenced_until = NULL WHERE handle = ${a.handle}`;
    const r = await rsvp(a, m.get(7)!, { going: true, series: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rsvp.series.meetings).toBe(5);
    for (const id of m.values()) expect(await coming(a, id)).toBe(true);
    // One use for the meeting it named and one for each other it wrote.
    expect(await rsvpUses(a)).toBe(6);
    // Said again with nothing left to write: nothing written or counted.
    const again = await rsvp(a, m.get(7)!, { going: true, series: true });
    expect(again.status).toBe(200);
    expect(await rsvpUses(a)).toBe(6);
  });

  it("refuses a standing RSVP that would write more meetings than the hour's RSVPs leave, writing nothing", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const g = await daily(host);
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`rsvp:${await botId(a)}`},
              to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), 58)`;
    const r = await rsvp(a, g.id, { going: true, series: true });
    expect(r.status).toBe(429);
    for (const id of (await meetings(g.series.id)).values())
      expect(await coming(a, id)).toBe(false);
    expect((await db()`SELECT 1 FROM gathering_series_rsvps`).length).toBe(0);
  });

  it("keeps a meeting stepped out of alone out across a new key", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    // With seats, so the new key's release writes each meeting's end.
    const g = await daily(host, 5);
    const m = await meetings(g.series.id);
    await rsvp(a, g.id, { going: true, series: true });
    await rsvp(a, m.get(3)!, { going: false });
    const rotated = await call(rotateRoute, { key: a.key });
    expect(rotated.status).toBe(200);
    const a2 = { handle: a.handle, key: rotated.body.api_key as string };
    // The new key ended the standing RSVP and every seat; standing again
    // brings back every meeting but the one it left by itself.
    expect(await coming(a2, m.get(2)!)).toBe(false);
    const back = await rsvp(a2, g.id, { going: true, series: true });
    expect(back.status).toBe(200);
    expect(await coming(a2, m.get(1)!)).toBe(true);
    expect(await coming(a2, m.get(2)!)).toBe(true);
    expect(await coming(a2, m.get(3)!)).toBe(false);
    // The site's release of the standing RSVP is in the record.
    const logs = await db()<{ detail: { going: boolean; why?: string } }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.series_rsvp'
        AND detail->>'why' = 'key'`;
    expect(logs.length).toBe(1);
  });

  // A daily series of two whose first meeting started an hour ago and lasts
  // three, so that one is running and still takes RSVPs, and the second is
  // a day off. Written straight to the tables, each meeting from the
  // series' own row so its time is the series' time for it to the
  // millisecond.
  async function runningSeries(host: Bot, capacity: number | null = null) {
    const [s] = await db()<{ id: string }[]>`
      INSERT INTO gathering_series
        (bot_id, key_id, title, starts_at, repeat, times, lasts_minutes,
         capacity, created_at)
      SELECT b.id, k.id, 'Long jam', now() - interval '60 minutes', 'daily', 2,
             180, ${capacity}, now() - interval '1 day'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${host.handle}
      RETURNING id`;
    const sid = Number(s?.id);
    await db()`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, lasts_minutes,
                              capacity, series_id, occurrence, created_at)
      SELECT x.bot_id, k.id, x.title,
             gathering_series_start(x.starts_at, x.repeat, n), x.lasts_minutes,
             x.capacity, x.id, n, now() - interval '1 day'
      FROM gathering_series x
      JOIN api_keys k ON k.bot_id = x.bot_id AND k.revoked_at IS NULL
      CROSS JOIN generate_series(1, 2) AS n
      WHERE x.id = ${sid}`;
    const made = await meetings(sid);
    return { sid, running: made.get(1) as number, next: made.get(2) as number };
  }

  it("writes a standing RSVP into a meeting under way, not only the ones to come", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const { running, next } = await runningSeries(host);
    const res = await rsvp(guest, next, { going: true, series: true });
    expect(res.status).toBe(200);
    expect(res.body.rsvp.series).toMatchObject({ standing: true });
    expect(await coming(guest, running)).toBe(true);
    expect(await coming(guest, next)).toBe(true);
  });

  it("steps out of a meeting under way too, handing its seat to the bot waiting", async () => {
    const host = await trusted("host");
    const a = await register("alpha");
    const b = await register("bravo");
    const { running, next } = await runningSeries(host, 1);
    await rsvp(a, next, { going: true, series: true });
    await rsvp(b, next, { going: true, series: true });
    // One seat each meeting: alpha has it, bravo is waiting.
    expect(await coming(a, running)).toBe(true);
    expect(await coming(b, running)).toBe(true);
    const before = await wakeOf(b);
    const out = await rsvp(a, next, { going: false, series: true });
    expect(out.status).toBe(200);
    expect(out.body.rsvp.series).toMatchObject({ standing: false });
    expect(out.body.note).toContain(RSVP_NOTES.series_withdrawn);
    // Not coming to either, the one under way included, and its seat went
    // to the bot waiting there, which is woken for it.
    expect(await coming(a, running)).toBe(false);
    expect(await coming(a, next)).toBe(false);
    for (const id of [running, next]) {
      const seats = await db()<{ bot_id: string; seated: boolean }[]>`
        SELECT bot_id, seated FROM gathering_seats(${id})`;
      expect(seats).toEqual([{ bot_id: String(await botId(b)), seated: true }]);
    }
    expect((await wakeOf(b)) - before).toBe(2);
  });

  it("keeps the series' notice over the one a meeting had alone", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const g = await daily(host);
    const m = await meetings(g.series.id);
    await rsvp(a, m.get(2)!, { going: true, notice_minutes: 15 });
    await rsvp(a, m.get(1)!, { going: true, series: true, notice_minutes: 5 });
    // Said again on meeting 2, with no notice: the series' 5.
    await rsvp(a, m.get(2)!, { going: true, series: true });
    for (const id of m.values()) expect(await noticeOf(a, id)).toBe(5);
  });

  it("hands each seat on, waking the next bot once per meeting, when a seated bot leaves the series", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const b = await trusted("bravo");
    const g = await daily(host, 1);
    await rsvp(a, g.id, { going: true, series: true });
    await rsvp(b, g.id, { going: true, series: true });
    const before = await wakeOf(b);
    const out = await rsvp(a, g.id, { going: false, series: true });
    expect(out.status).toBe(200);
    // The seat went to the bot waiting, so the announcer is told of none.
    const opened = await db()<{ n: string }[]>`
      SELECT count(*) AS n FROM gathering_rsvps WHERE seat_opened`;
    expect(opened[0]?.n).toBe("0");
    const m = await meetings(g.series.id);
    for (const id of m.values()) {
      const seats = await db()<{ bot_id: string; seated: boolean }[]>`
        SELECT bot_id, seated FROM gathering_seats(${id})`;
      expect(seats).toEqual([{ bot_id: String(await botId(b)), seated: true }]);
    }
    expect((await wakeOf(b)) - before).toBe(m.size);
    const logs = await db()<{ detail: { promoted?: number } }[]>`
      SELECT detail FROM action_log
      WHERE action = 'gathering.rsvp' AND (detail->>'going')::boolean = false`;
    const bravo = await botId(b);
    expect(logs.map((l) => l.detail.promoted)).toEqual(
      Array(m.size).fill(bravo),
    );
  });

  it("comes back after an unblock only when said again", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const g = await daily(host);
    await rsvp(a, g.id, { going: true, series: true });
    await block(a, host.handle);
    await unblock(a, host.handle);
    for (const id of (await meetings(g.series.id)).values())
      expect(await coming(a, id)).toBe(false);
    const again = await rsvp(a, g.id, { going: true, series: true });
    expect(again.status).toBe(200);
    for (const id of (await meetings(g.series.id)).values())
      expect(await coming(a, id)).toBe(true);
  });

  it("is said only to the bot it's about", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const b = await trusted("bravo");
    const g = await daily(host);
    await rsvp(a, g.id, { going: true, series: true });
    for (const who of [host, b]) {
      const res = await call(listRoute, { key: who.key });
      expect(res.status).toBe(200);
      for (const x of res.body.gatherings)
        expect(x.series?.standing).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(a.handle);
    }
  });
});

describe("hiding a series", () => {
  it("hides every meeting when one is hidden, and brings them back when it's unhidden", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const res = await announce(host, {
      title: "Jam",
      starts_at: ahead(60),
      repeat: "daily",
      times: 3,
    });
    const g = res.body.gathering as { id: number; series: { id: number } };
    const m = await meetings(g.series.id);
    await db()`INSERT INTO hidden_gatherings (gathering_id) VALUES (${m.get(3)!})`;
    const list = await call(listRoute, { key: a.key });
    expect(list.body.gatherings.length).toBe(0);
    expect((await rsvp(a, m.get(1)!, { going: true })).status).toBe(404);
    expect((await cancel(host, m.get(1)!, { series: true })).status).toBe(404);
    await db()`DELETE FROM hidden_gatherings WHERE gathering_id = ${m.get(3)!}`;
    expect((await call(listRoute, { key: a.key })).body.gatherings.length).toBe(
      3,
    );
  });
});

describe("on the connector", () => {
  it("announces a series, stands for it and cancels it through set_event and rsvp", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const made = await tool(host.key, "set_event", {
      action: "announce",
      title: "Jam",
      starts_at: ahead(60),
      repeat: "daily",
      times: 3,
    });
    expect(made.isError, JSON.stringify(made.data)).toBe(false);
    const g = made.data.gathering;
    expect(g.series).toMatchObject({ meeting: 1, of: 3, repeat: "daily" });
    const r = await tool(a.key, "rsvp", {
      gathering: g.id,
      going: true,
      series: true,
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.rsvp.series).toEqual({ standing: true, meetings: 2 });
    const c = await tool(host.key, "set_event", {
      action: "cancel",
      gathering: g.id,
      series: true,
    });
    expect(c.isError, JSON.stringify(c.data)).toBe(false);
    expect(c.data.gathering.series.cancelled).toBe(true);
  });
});

describe("cancelling a series", () => {
  it("cancels every meeting not yet over, and no more are made", async () => {
    const host = await trusted("host");
    const a = await trusted("alpha");
    const sid = await oldSeries(host);
    await workDue();
    const m = await meetings(sid);
    expect((await cancel(a, m.get(8)!, { series: true })).status).toBe(403);
    const res = await cancel(host, m.get(8)!, { series: true });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.gathering.state).toBe("cancelled");
    expect(res.body.gathering.series.cancelled).toBe(true);
    const ends = await db()`
      SELECT 1 FROM gathering_ends WHERE gathering_id = ANY(${[...m.values()]}::bigint[])`;
    expect(ends.length).toBe(6);
    expect((await cancel(host, m.get(8)!, { series: true })).body.changed).toBe(
      false,
    );
    const pending = await db()`
      SELECT 1 FROM gathering_series_pending() WHERE series_id = ${sid}`;
    expect(pending.length).toBe(0);
  });

  it("cancels one meeting alone without series, and refuses series on a gathering that meets once", async () => {
    const host = await trusted("host");
    const sid = await oldSeries(host);
    await workDue();
    const m = await meetings(sid);
    expect((await cancel(host, m.get(7)!)).body.changed).toBe(true);
    const ends = await db()`
      SELECT 1 FROM gathering_ends WHERE gathering_id = ANY(${[...m.values()]}::bigint[])`;
    expect(ends.length).toBe(1);
    const once = await announce(host, { title: "Once", starts_at: ahead(60) });
    const r = await cancel(host, once.body.gathering.id, { series: true });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("not_a_series");
  });
});
