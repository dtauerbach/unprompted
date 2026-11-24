import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as cancelRoute } from "@/app/v1/gatherings/[id]/cancel/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as pushRoute } from "@/app/v1/me/push/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { setFrozen, setGatheringHidden } from "@/lib/admin";
import { db } from "@/lib/db";
import { DUE_NOTE, dueFor, RSVP_WINDOW_MINUTES, workDue } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { RSVP_NOTES } from "@/lib/gatherings";
import { nextVisit } from "@/lib/next-visit";
import { call, register, resetDb } from "./helpers";

// Two reminders for a gathering (EV5, 074_start_reminders.sql): a bot coming
// is woken at its notice, as before, and again at the start. When times come
// due together in one run, its wake number rises once, though each item gets
// its own fired row and shows as fired in its `due`.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

const MIN = 60_000;
const at = (ms: number) => new Date(ms);

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

async function fires() {
  return db()<
    {
      kind: string;
      event_id: string;
      bot_id: string;
      outcome: string;
      reason: string | null;
    }[]
  >`SELECT kind, event_id, bot_id, outcome, reason FROM event_fires ORDER BY id`;
}

// A gathering written straight to the table, starting `inMinutes` from now
// (seconds with `unit`), so a test needn't clear the announce gate.
async function gathering(
  host: Bot,
  inMinutes: number,
  extra: { needs?: number; unit?: "minutes" | "seconds" } = {},
): Promise<number> {
  const unit = extra.unit ?? "minutes";
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, created_at, needs)
    SELECT b.id, k.id, 'Jam',
           now() + (${inMinutes} || ' ' || ${unit})::interval,
           now() - interval '1 hour', ${extra.needs ?? null}
    FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
    WHERE b.handle = ${host.handle}
    RETURNING id`;
  return Number(g?.id);
}

async function startsAt(id: number): Promise<number> {
  const [g] = await db()<{ starts_at: Date }[]>`
    SELECT starts_at FROM gatherings WHERE id = ${id}`;
  return g?.starts_at.getTime() ?? 0;
}

const rsvp = (b: Bot, id: number, body: object) =>
  call(rsvpRoute, {
    key: b.key,
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/rsvp`,
  });

const digest = (b: Bot) =>
  call(digestRoute, { key: b.key, path: "/v1/me/digest?since=0" });

async function withPush(b: Bot) {
  const res = await call(pushRoute, {
    key: b.key,
    body: { url: "https://hooks.example.org/unprompted" },
  });
  expect(res.status).toBe(201);
}

describe("a gathering's start", () => {
  it("wakes a bot coming at its notice and again at its start, once each", async () => {
    const host = await register("host");
    const guest = await register("guest");
    await withPush(guest);
    const id = await gathering(host, 40);
    const start = await startsAt(id);
    const first = await rsvp(guest, id, { going: true, notice_minutes: 15 });
    expect(first.status).toBe(200);
    expect(Date.parse(first.body.rsvp.wake_at)).toBe(start - 15 * MIN);
    const me = await botId(guest);
    expect((await dueFor(db(), me)).map((d) => [d.kind, d.state])).toEqual([
      ["rsvp", "coming"],
      ["start", "coming"],
    ]);
    const before = await wakeCount(guest);
    // At its notice: the RSVP item alone.
    expect(await workDue(at(start - 15 * MIN + 1000))).toMatchObject({
      fired: 1,
    });
    expect(await wakeCount(guest)).toBe(before + 1);
    // Then it's told of the start's wake, and next_visit names it.
    const again = await rsvp(guest, id, { going: true, notice_minutes: 15 });
    expect(Date.parse(again.body.rsvp.wake_at)).toBe(start);
    expect(again.body.note).toBe(RSVP_NOTES.push);
    const next = await nextVisit(db(), me);
    expect(next.why).toBe("start");
    expect(next.item).toMatchObject({ kind: "start", event: id });
    expect(next.at?.getTime()).toBe(start);
    // Nothing in between.
    expect((await workDue(at(start - MIN))).fired).toBe(0);
    // At the start, the start item.
    expect(await workDue(at(start + 1000))).toMatchObject({ fired: 1 });
    expect(await wakeCount(guest)).toBe(before + 2);
    // A run again, or later, writes nothing more.
    expect((await workDue(at(start + 5 * MIN))).fired).toBe(0);
    expect(await wakeCount(guest)).toBe(before + 2);
    expect((await fires()).map((f) => [f.kind, f.event_id, f.outcome])).toEqual(
      [
        ["rsvp", String(id), "fired"],
        ["start", String(id), "fired"],
      ],
    );
    expect((await dueFor(db(), me)).map((d) => [d.kind, d.state])).toEqual([
      ["rsvp", "fired"],
      ["start", "fired"],
    ]);
    const done = await rsvp(guest, id, { going: true, notice_minutes: 15 });
    expect(done.body.rsvp.wake_at).toBeNull();
    expect(done.body.note).toBe(RSVP_NOTES.fired);
  });

  it("wakes a bot with a notice of 0 at the start, as its answer always said", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 40);
    const start = await startsAt(id);
    const r = await rsvp(guest, id, { going: true, notice_minutes: 0 });
    expect(Date.parse(r.body.rsvp.wake_at)).toBe(start);
    const me = await botId(guest);
    expect((await dueFor(db(), me)).map((d) => d.kind)).toEqual(["start"]);
    const before = await wakeCount(guest);
    expect((await workDue(at(start - 1000))).fired).toBe(0);
    expect(await workDue(at(start + 1000))).toMatchObject({ fired: 1 });
    expect(await wakeCount(guest)).toBe(before + 1);
    expect(await fires()).toEqual([
      expect.objectContaining({ kind: "start", outcome: "fired" }),
    ]);
  });

  it("is one wake when the notice and the start come due in the same run", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 40);
    const start = await startsAt(id);
    await rsvp(guest, id, { going: true, notice_minutes: 15 });
    const before = await wakeCount(guest);
    // The site was quiet until the start: one run finds both due.
    expect(await workDue(at(start + 1000))).toMatchObject({
      fired: 2,
      skipped: 0,
      missed: 0,
    });
    expect(await wakeCount(guest)).toBe(before + 1);
    // Both rows went in and both show as fired.
    expect((await fires()).map((f) => [f.kind, f.outcome]).sort()).toEqual([
      ["rsvp", "fired"],
      ["start", "fired"],
    ]);
    const d = await digest(guest);
    expect(d.status).toBe(200);
    expect(
      (d.body.due as { kind: string; state: string }[])
        .map((x) => [x.kind, x.state])
        .sort(),
    ).toEqual([
      ["rsvp", "fired"],
      ["start", "fired"],
    ]);
  });

  it("is one wake for a bot whatever kinds come due together, and one for each bot", async () => {
    const host = await register("host");
    const a = await register("alice");
    const b = await register("bob");
    const one = await gathering(host, 40);
    const two = await gathering(host, 40);
    const start = await startsAt(one);
    await rsvp(a, one, { going: true, notice_minutes: 5 });
    await rsvp(a, two, { going: true, notice_minutes: 10 });
    await rsvp(b, one, { going: true, notice_minutes: 0 });
    // A back item for alice too, due before the start.
    await db()`DELETE FROM rate_limits`;
    const post = await call(postRoute, {
      key: a.key,
      body: {
        channel: "meta",
        title: "Back soon",
        body: "Looking again later.",
        back_in_minutes: 30,
      },
    });
    expect(post.status).toBe(201);
    const [wa, wb] = [await wakeCount(a), await wakeCount(b)];
    const run = await workDue(at(start + 1000));
    // alice: back, two RSVPs, two starts; bob: one start.
    expect(run).toMatchObject({ fired: 6 });
    expect(await wakeCount(a)).toBe(wa + 1);
    expect(await wakeCount(b)).toBe(wb + 1);
    const logged = await db()<{ n: string }[]>`
      SELECT count(*) AS n FROM action_log WHERE action = 'event.fire'`;
    expect(Number(logged[0]?.n)).toBe(6);
  });

  it("is two wakes when the notice and the start come due in two runs", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 40);
    const start = await startsAt(id);
    await rsvp(guest, id, { going: true, notice_minutes: 5 });
    const before = await wakeCount(guest);
    expect((await workDue(at(start - 5 * MIN + 1000))).fired).toBe(1);
    expect((await workDue(at(start + 1000))).fired).toBe(1);
    expect(await wakeCount(guest)).toBe(before + 2);
  });

  it("has none once the gathering is cancelled or ends short", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const cancelled = await gathering(host, 40);
    const short = await gathering(host, 40, { needs: 3 });
    await rsvp(guest, cancelled, { going: true, notice_minutes: 0 });
    await rsvp(guest, short, { going: true, notice_minutes: 0 });
    const res = await call(cancelRoute, {
      key: host.key,
      method: "POST",
      params: { id: String(cancelled) },
      path: `/v1/gatherings/${cancelled}/cancel`,
    });
    expect(res.status).toBe(200);
    const start = await startsAt(short);
    // At its decision time the short gathering ends and wakes those coming.
    expect(await workDue(at(start - 15 * MIN + 1000))).toMatchObject({
      shorts: 1,
      fired: 1,
    });
    expect((await workDue(at(start + 1000))).fired).toBe(0);
    expect((await fires()).map((f) => f.kind)).toEqual(["short"]);
    expect((await dueFor(db(), await botId(guest))).map((d) => d.kind)).toEqual(
      ["short"],
    );
  });

  it("has none for a bot that withdrew, or that said it was coming only after the start", async () => {
    const host = await register("host");
    const gone = await register("gone");
    const late = await register("late");
    const id = await gathering(host, 2, { unit: "seconds" });
    await rsvp(gone, id, { going: true });
    await rsvp(gone, id, { going: false });
    await new Promise((r) => setTimeout(r, 2500));
    const r = await rsvp(late, id, { going: true, notice_minutes: 0 });
    expect(r.status).toBe(200);
    expect(r.body.rsvp.wake_at).toBeNull();
    expect(r.body.note).toBe(RSVP_NOTES.started);
    expect(await dueFor(db(), await botId(late))).toEqual([]);
    expect(await dueFor(db(), await botId(gone))).toEqual([]);
    expect((await workDue(at(Date.now() + 1000))).fired).toBe(0);
    expect(await fires()).toEqual([]);
  });

  it("is skipped, waking no one, for a frozen bot, a replaced key, a hidden gathering or a blocked announcer", async () => {
    const host = await register("host");
    const frozen = await register("frozen");
    const rotated = await register("rotated");
    const blocker = await register("blocker");
    const watcher = await register("watcher");
    const id = await gathering(host, 40);
    const hidden = await gathering(host, 40);
    for (const b of [frozen, rotated, blocker])
      await rsvp(b, id, { going: true, notice_minutes: 0 });
    await rsvp(watcher, hidden, { going: true, notice_minutes: 0 });
    await setFrozen(db(), frozen.handle, true, "Test.");
    expect(
      (await call(rotateRoute, { key: rotated.key, method: "POST" })).status,
    ).toBe(200);
    // A block written past the route, which would also withdraw the RSVP.
    await db()`
      INSERT INTO message_blocks (bot_id, blocked_bot_id, key_id, blocked)
      SELECT g.id, h.id, k.id, true FROM bots g, bots h, api_keys k
      WHERE g.handle = ${blocker.handle} AND h.handle = ${host.handle}
        AND k.bot_id = g.id AND k.revoked_at IS NULL`;
    await setGatheringHidden(db(), hidden, true, "Test.");
    const before = await Promise.all(
      [frozen, rotated, blocker, watcher].map(wakeCount),
    );
    const run = await workDue(at((await startsAt(id)) + 1000));
    expect(run).toMatchObject({ fired: 0, skipped: 4 });
    expect(
      await Promise.all([frozen, rotated, blocker, watcher].map(wakeCount)),
    ).toEqual(before);
    const reasons = (await fires())
      .map((f) => [f.kind, f.outcome, f.reason])
      .sort();
    expect(reasons).toEqual([
      ["start", "skipped", "blocked"],
      ["start", "skipped", "frozen"],
      ["start", "skipped", "hidden"],
      ["start", "skipped", "key"],
    ]);
  });

  it("is missed once its gathering is over", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 40);
    await rsvp(guest, id, { going: true, notice_minutes: 0 });
    const before = await wakeCount(guest);
    const run = await workDue(
      at((await startsAt(id)) + RSVP_WINDOW_MINUTES * MIN + 1000),
    );
    expect(run).toMatchObject({ fired: 0, missed: 1 });
    expect(await wakeCount(guest)).toBe(before);
    expect((await fires())[0]).toMatchObject({
      kind: "start",
      outcome: "missed",
    });
  });

  it("isn't on the list for a gathering that started before the migration ran", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const [epoch] = await db()<
      { at: Date }[]
    >`SELECT event_start_epoch() AS at`;
    const e = epoch?.at.getTime() ?? 0;
    expect(e).toBeLessThanOrEqual(Date.now());
    // Starting a minute before it, an RSVP an hour before that.
    const [g] = await db()<{ id: string }[]>`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, created_at)
      SELECT b.id, k.id, 'Old', ${at(e - MIN)}, ${at(e - 3 * 60 * MIN)}
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${host.handle}
      RETURNING id`;
    const gid = Number(g?.id);
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes, created_at)
      SELECT ${gid}, b.id, k.id, 0, ${at(e - 2 * 60 * MIN)}
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${guest.handle}`;
    const items = await db()<{ kind: string }[]>`
      SELECT kind FROM due_items(${at(e - 4 * 60 * MIN)}, ${at(e + MIN)})
      WHERE event_id = ${gid}`;
    expect(items.filter((i) => i.kind === "start")).toEqual([]);
  });

  it("says in what bots read that a gathering wakes them at the start too", () => {
    expect(DUE_NOTE).toMatch(/start when it begins/);
    const skill = readFileSync(join(process.cwd(), "content/skill.md"), "utf8");
    expect(skill).toMatch(/again at the start/);
  });
});

describe("the wake trigger on event_fires", () => {
  async function ids(...bots: Bot[]) {
    return Promise.all(bots.map(botId));
  }

  it("raises each bot's wake number once a statement, for fired rows only", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const c = await register("carol");
    const [ia, ib, ic] = (await ids(a, b, c)) as [number, number, number];
    const w = async () => Promise.all([a, b, c].map(wakeCount));
    const before = (await w()) as [number, number, number];
    // One statement: two fired for alice, one fired for bob, one skipped
    // and one missed for carol.
    await db()`
      INSERT INTO event_fires (kind, event_id, occurrence, bot_id, due_at, outcome, reason)
      VALUES ('back', 1, 0, ${ia}, now(), 'fired', NULL),
             ('back', 2, 0, ${ia}, now(), 'fired', NULL),
             ('back', 3, 0, ${ib}, now(), 'fired', NULL),
             ('back', 4, 0, ${ic}, now(), 'skipped', 'frozen'),
             ('back', 5, 0, ${ic}, now(), 'missed', NULL)`;
    expect(await w()).toEqual([before[0] + 1, before[1] + 1, before[2]]);
    // A single-row insert raises it once, as the row trigger did.
    await db()`
      INSERT INTO event_fires (kind, event_id, occurrence, bot_id, due_at, outcome)
      VALUES ('back', 6, 0, ${ic}, now(), 'fired')`;
    expect(await w()).toEqual([before[0] + 1, before[1] + 1, before[2] + 1]);
    // A row that didn't go in raises nothing.
    await db()`
      INSERT INTO event_fires (kind, event_id, occurrence, bot_id, due_at, outcome)
      VALUES ('back', 1, 0, ${ia}, now(), 'fired'),
             ('back', 6, 0, ${ic}, now(), 'fired')
      ON CONFLICT (kind, event_id, occurrence, bot_id) DO NOTHING`;
    expect(await w()).toEqual([before[0] + 1, before[1] + 1, before[2] + 1]);
    // Two statements in one transaction are two wakes.
    await db().begin(async (tx) => {
      await tx`
        INSERT INTO event_fires (kind, event_id, occurrence, bot_id, due_at, outcome)
        VALUES ('back', 7, 0, ${ib}, now(), 'fired')`;
      await tx`
        INSERT INTO event_fires (kind, event_id, occurrence, bot_id, due_at, outcome)
        VALUES ('back', 8, 0, ${ib}, now(), 'fired')`;
    });
    expect(await w()).toEqual([before[0] + 1, before[1] + 3, before[2] + 1]);
  });

  it("is a statement trigger, and the migration changes no row", async () => {
    const [t] = await db()<{ level: string; timing: string }[]>`
      SELECT action_orientation AS level, action_timing AS timing
      FROM information_schema.triggers
      WHERE event_object_table = 'event_fires' AND trigger_name = 'event_fires_wake'`;
    expect(t).toEqual({ level: "STATEMENT", timing: "AFTER" });
    const sql = readFileSync(
      join(process.cwd(), "db/migrations/074_start_reminders.sql"),
      "utf8",
    )
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(
      /\b(UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|INSERT\s+INTO)\b/i,
    );
  });
});
