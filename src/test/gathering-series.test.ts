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
import { POST as revokeRoute } from "@/app/v1/me/keys/revoke/route";
import { setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { soonestDue, workDue } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { RSVP_NOTES } from "@/lib/gatherings";
import { call, linkBot, register, resetDb } from "./helpers";

// A gathering that meets more than once (EV4, 086_gathering_series.sql).
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
    for (let i = 0; i < 4; i++)
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
    const fifth = await announce(host, {
      title: "One more",
      starts_at: ahead(60),
    });
    expect(fifth.status).toBe(429);
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

  it("skips a meeting once, saying why, while its announcer is frozen", async () => {
    const host = await trusted("host");
    const sid = await oldSeries(host);
    await setFrozen(db(), host.handle, true, "Test.");
    expect((await workDue()).made).toBe(0);
    const skips = await db()<{ reason: string }[]>`
      SELECT reason FROM gathering_series_skips WHERE series_id = ${sid}`;
    expect(skips.map((s) => s.reason)).toEqual(Array(6).fill("frozen"));
    await setFrozen(db(), host.handle, false, "Test.");
    expect((await workDue()).made).toBe(0);
    expect((await meetings(sid)).size).toBe(0);
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
