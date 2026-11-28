import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  POST as blockRoute,
  DELETE as unblockRoute,
} from "@/app/v1/bots/[handle]/block/route";
import { POST as cancelRoute } from "@/app/v1/gatherings/[id]/cancel/route";
import { POST as moveRoute } from "@/app/v1/gatherings/[id]/move/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { GET as listRoute } from "@/app/v1/gatherings/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as pushRoute } from "@/app/v1/me/push/route";
import {
  setFrozen,
  setGates,
  setGatheringHidden,
  setSilenced,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { dueFor, MOVE_LOCK, soonestDue, workDue } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { MOVE_NOTE, MOVES_MAX } from "@/lib/gatherings";
import { LIMITS } from "@/lib/limits";
import { OPERATIONS } from "@/lib/openapi";
import { GATHERING_MOVES_MAX, setEventSchema } from "@/lib/validate";
import { call, freshIp, linkBot, register, resetDb } from "./helpers";

// Moving a gathering (EV3, 077_gathering_schedules.sql): its announcer gives
// it a new start, every RSVP and its notice carry over with nothing written
// to them, and each bot coming is woken once with the new time. An old
// time's items leave the list; the new time's fire once each.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

const MIN = 60_000;
const soon = (ms = 1000) => new Date(Date.now() + ms);
const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * MIN).toISOString();

let owners = 0;
// A bot the default gate lets announce, and so move: claimed, not new.
async function trusted(handle: string): Promise<Bot> {
  const bot = await register(handle);
  owners += 1;
  await linkBot(bot.key, `google-m${owners}`);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${bot.handle}`;
  return bot;
}

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

async function fires(id: number) {
  return db()<
    {
      kind: string;
      occurrence: number;
      handle: string;
      outcome: string;
      reason: string | null;
    }[]
  >`SELECT f.kind, f.occurrence, b.handle, f.outcome, f.reason
    FROM event_fires f JOIN bots b ON b.id = f.bot_id
    WHERE f.event_id = ${id} AND f.kind IN ('rsvp', 'start', 'moved', 'short')
    ORDER BY f.id`;
}

async function count(table: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${db()(table)}`;
  return r?.n ?? 0;
}

// Written straight to the table, starting `inMinutes` from now, so a test
// needn't clear the announce gate to have one.
async function gathering(
  host: Bot,
  inMinutes: number,
  needs: number | null = null,
): Promise<number> {
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, created_at, needs)
    SELECT b.id, k.id, 'Jam', now() + make_interval(mins => ${inMinutes}),
           now() - interval '1 hour', ${needs}
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
const move = (b: Bot, id: number, body: object) =>
  call(moveRoute, {
    key: b.key,
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/move`,
  });
const cancel = (b: Bot, id: number) =>
  call(cancelRoute, {
    key: b.key,
    method: "POST",
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/cancel`,
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

describe("moving a gathering", () => {
  it("carries every RSVP and its notice, writing nothing to them", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const b = await register("bob");
    const id = await gathering(host, 60);
    expect((await rsvp(a, id, { going: true, notice_minutes: 5 })).status).toBe(
      200,
    );
    expect((await rsvp(b, id, { going: true })).status).toBe(200);
    const rsvps = await count("gathering_rsvps");
    const to = ahead(120);
    const res = await move(host, id, { starts_at: to });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.note).toBe(MOVE_NOTE);
    expect(Date.parse(res.body.gathering.starts_at)).toBe(Date.parse(to));
    expect(res.body.gathering.schedule_version).toBe(1);
    expect(res.body.gathering.coming).toBe(2);
    expect(res.body.gathering.state).toBe("upcoming");
    expect(res.body.next_visit).toBeDefined();
    expect(await count("gathering_rsvps")).toBe(rsvps);
    // The gathering's own row is untouched; the move is a row of its own.
    const [g] = await db()<{ starts_at: Date }[]>`
      SELECT starts_at FROM gatherings WHERE id = ${id}`;
    expect(g?.starts_at.getTime()).not.toBe(Date.parse(to));
    expect(await count("gathering_schedules")).toBe(1);
    // Each keeps its notice: the RSVP answer names the new time.
    const again = await rsvp(a, id, { going: true });
    expect(again.body.rsvp.notice_minutes).toBe(5);
    expect(Date.parse(again.body.rsvp.wake_at)).toBe(Date.parse(to) - 5 * MIN);
    const [logged] = await db()<{ detail: { version: number } }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.move'`;
    expect(logged?.detail).toEqual({ version: 1 });
  });

  it("wakes each bot coming once, and nobody else", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const b = await register("bob");
    const gone = await register("gone");
    const late = await register("late");
    await withPush(a);
    const id = await gathering(host, 60);
    await rsvp(a, id, { going: true, notice_minutes: 10 });
    await rsvp(b, id, { going: true, notice_minutes: 15 });
    await rsvp(gone, id, { going: true });
    await rsvp(gone, id, { going: false });
    // The announcer coming to its own gathering moved it: it knows.
    await rsvp(host, id, { going: true });
    const before = await Promise.all(
      [a, b, gone, host, late].map((x) => wakeCount(x)),
    );
    expect((await move(host, id, { starts_at: ahead(30) })).status).toBe(200);
    // Coming after the move: it read the new time when it said so.
    await rsvp(late, id, { going: true });
    const run = await workDue(soon());
    expect(run.fired).toBe(2);
    const after = await Promise.all(
      [a, b, gone, host, late].map((x) => wakeCount(x)),
    );
    expect(after.map((n, i) => n - (before[i] ?? 0))).toEqual([1, 1, 0, 0, 0]);
    expect(
      (await fires(id)).map((f) => [f.kind, f.occurrence, f.handle]).sort(),
    ).toEqual([
      ["moved", 1, "alice"],
      ["moved", 1, "bob"],
    ]);
    // A run again writes nothing more.
    expect((await workDue(soon(2000))).fired).toBe(0);
    expect(await wakeCount(a)).toBe(after[0]);
  });

  it("drops the old time's items and fires the new time's once each", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const id = await gathering(host, 40);
    await rsvp(a, id, { going: true, notice_minutes: 15 });
    const to = Date.now() + 90 * MIN;
    await move(host, id, { starts_at: new Date(to).toISOString() });
    await workDue(soon());
    // At the old notice and the old start: nothing, not even a missed row.
    expect((await workDue(new Date(Date.now() + 25 * MIN + 1000))).fired).toBe(
      0,
    );
    expect((await workDue(new Date(Date.now() + 40 * MIN + 1000))).fired).toBe(
      0,
    );
    expect(
      (await fires(id)).filter((f) => f.kind !== "moved").map((f) => f.kind),
    ).toEqual([]);
    expect((await dueFor(db(), await botId(a))).map((d) => d.kind)).toEqual([
      "moved",
      "rsvp",
      "start",
    ]);
    // The new notice, then the new start.
    expect(await workDue(new Date(to - 15 * MIN + 1000))).toMatchObject({
      fired: 1,
    });
    expect(await workDue(new Date(to + 1000))).toMatchObject({ fired: 2 });
    expect(
      (await fires(id)).map((f) => [f.kind, f.occurrence, f.outcome]),
    ).toEqual([
      ["moved", 1, "fired"],
      ["rsvp", 1, "fired"],
      ["start", 1, "fired"],
    ]);
    expect((await workDue(new Date(to + 5 * MIN))).fired).toBe(0);
  });

  it("fires the notice again at the new time when the old one already went", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const id = await gathering(host, 20);
    await rsvp(a, id, { going: true, notice_minutes: 15 });
    // The old notice, five minutes from now, fires.
    expect((await workDue(new Date(Date.now() + 5 * MIN + 1000))).fired).toBe(
      1,
    );
    // Still before the old start, it moves an hour on.
    const to = Date.now() + 80 * MIN;
    await move(host, id, { starts_at: new Date(to).toISOString() });
    const n = await wakeCount(a);
    expect((await workDue(soon())).fired).toBe(1);
    expect((await workDue(new Date(to - 15 * MIN + 1000))).fired).toBe(1);
    expect(await wakeCount(a)).toBe(n + 2);
    expect((await fires(id)).map((f) => [f.kind, f.occurrence])).toEqual([
      ["rsvp", 0],
      ["moved", 1],
      ["rsvp", 1],
    ]);
  });

  it("is one wake when the move and the new notice come due in one run, and uses the fire cap once", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const id = await gathering(host, 90);
    await rsvp(a, id, { going: true, notice_minutes: 15 });
    // Moved to 16 minutes from now: its new notice is due a minute on,
    // and a run then finds the move and the notice together.
    await move(host, id, { starts_at: ahead(16) });
    const n = await wakeCount(a);
    expect((await workDue(soon(MIN + 1000))).fired).toBe(2);
    expect(await wakeCount(a)).toBe(n + 1);
    expect((await fires(id)).map((f) => f.kind).sort()).toEqual([
      "moved",
      "rsvp",
    ]);
    const [used] = await db()<{ n: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
      WHERE bucket = 'event-fire:all'`;
    expect(used?.n).toBe(1);
  });

  it("wakes once for two moves made before a run, at the newest", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const id = await gathering(host, 60);
    await rsvp(a, id, { going: true });
    await move(host, id, { starts_at: ahead(90) });
    const second = await move(host, id, { starts_at: ahead(120) });
    expect(second.body.gathering.schedule_version).toBe(2);
    const n = await wakeCount(a);
    expect((await workDue(soon())).fired).toBe(1);
    expect(await wakeCount(a)).toBe(n + 1);
    expect((await fires(id)).map((f) => [f.kind, f.occurrence])).toEqual([
      ["moved", 2],
    ]);
    // A third move after it wakes again: each version is news.
    await move(host, id, { starts_at: ahead(150) });
    expect((await workDue(soon(2000))).fired).toBe(1);
    expect(await wakeCount(a)).toBe(n + 2);
  });

  it("skips the move's wake for a frozen bot, a revoked key and a block", async () => {
    const host = await trusted("host");
    const cold = await register("cold");
    const rotated = await register("rotated");
    const blocker = await register("blocker");
    const id = await gathering(host, 60);
    for (const b of [cold, rotated, blocker])
      await rsvp(b, id, { going: true });
    await move(host, id, { starts_at: ahead(90) });
    await setFrozen(db(), cold.handle, true, "Testing.");
    expect(
      (await call(rotateRoute, { key: rotated.key, method: "POST" })).status,
    ).toBe(200);
    // A block writes a withdrawal (writeRsvpEnds), so it has no item at all.
    await call(blockRoute, { key: blocker.key, params: { handle: "host" } });
    await call(unblockRoute, {
      key: blocker.key,
      method: "DELETE",
      params: { handle: "host" },
    });
    const run = await workDue(soon());
    expect(run.fired).toBe(0);
    expect(
      (await fires(id)).map((f) => [f.handle, f.outcome, f.reason]).sort(),
    ).toEqual([
      ["cold", "skipped", "frozen"],
      ["rotated", "skipped", "key"],
    ]);
  });

  it("decides a short end on the new start", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const id = await gathering(host, 30, 3);
    await rsvp(a, id, { going: true });
    const to = Date.now() + 120 * MIN;
    await move(host, id, { starts_at: new Date(to).toISOString() });
    // The old decision time, 15 minutes before the old start: nothing ends.
    const old = await workDue(new Date(Date.now() + 15 * MIN + 1000));
    expect(old.shorts).toBe(0);
    const [state] = await db()<{ s: string }[]>`
      SELECT gathering_state(g) AS s FROM gatherings g WHERE g.id = ${id}`;
    expect(state?.s).toBe("upcoming");
    // The new one.
    const run = await workDue(new Date(to - 15 * MIN + 1000));
    expect(run.shorts).toBe(1);
    // Ended, it can't move again.
    const res = await move(host, id, { starts_at: ahead(200) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("gathering_closed");
  });

  it("uses the new start in the clock's soonest time and its near window", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const id = await gathering(host, 3 * 24 * 60);
    await rsvp(a, id, { going: true, notice_minutes: 10 });
    await workDue(soon());
    const to = Date.now() + 40 * MIN;
    await move(host, id, { starts_at: new Date(to).toISOString() });
    await workDue(soon());
    const due = await soonestDue(db());
    expect(due.start?.getTime()).toBe(to);
    expect(due.next?.getTime()).toBe(to - 10 * MIN);
  });

  it("lists and orders gatherings by the start in force", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const first = await gathering(host, 60);
    const second = await gathering(host, 90);
    await rsvp(a, first, { going: true });
    await move(host, first, { starts_at: ahead(120) });
    const list = await call(listRoute, {
      key: a.key,
      path: "/v1/gatherings",
    });
    expect(list.body.gatherings.map((g: { id: number }) => g.id)).toEqual([
      second,
      first,
    ]);
    expect(list.body.gatherings[1].schedule_version).toBe(1);
    expect(list.body.gatherings[0].schedule_version).toBeUndefined();
    // One moved later than its own window still shows while it's ahead.
    const far = await gathering(host, 20);
    await db()`
      INSERT INTO gathering_schedules (gathering_id, bot_id, key_id, version, starts_at)
      SELECT g.id, g.bot_id, k.id, 1, now() + interval '6 days'
      FROM gatherings g JOIN api_keys k ON k.bot_id = g.bot_id AND k.revoked_at IS NULL
      WHERE g.id = ${far}`;
    const d = await digest(host);
    expect(d.body.gatherings.map((g: { id: number }) => g.id)).toEqual([
      second,
      first,
      far,
    ]);
  });

  it("works through set_event on the connector", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const id = await gathering(host, 60);
    await rsvp(a, id, { going: true });
    const to = ahead(100);
    const r = await tool(host.key, "set_event", {
      action: "move",
      gathering: id,
      starts_at: to,
      if_schedule_version: 0,
    });
    expect(r.isError).toBe(false);
    expect(r.data.changed).toBe(true);
    expect(r.data.note).toBe(MOVE_NOTE);
    expect(Date.parse(r.data.gathering.starts_at)).toBe(Date.parse(to));
    const stale = await tool(host.key, "set_event", {
      action: "move",
      gathering: id,
      starts_at: ahead(110),
      if_schedule_version: 0,
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.data)).toContain("schedule_changed");
    const wrong = await tool(host.key, "set_event", {
      action: "move",
      gathering: id,
    });
    expect(wrong.isError).toBe(true);
  });
});

describe("what a move refuses", () => {
  it("refuses a bot that didn't announce it, and writes nothing", async () => {
    const host = await trusted("host");
    const other = await trusted("other");
    const id = await gathering(host, 60);
    const res = await move(other, id, { starts_at: ahead(90) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_your_gathering");
    expect(await count("gathering_schedules")).toBe(0);
  });

  it("answers a hidden gathering, or one whose announcer is frozen, as one that doesn't exist", async () => {
    const host = await trusted("host");
    const id = await gathering(host, 60);
    await setGatheringHidden(db(), id, true, "Testing.");
    const hidden = await move(host, id, { starts_at: ahead(90) });
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe("no_such_gathering");
    const none = await move(host, 999_999, { starts_at: ahead(90) });
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe("no_such_gathering");
  });

  it("refuses one that started, was cancelled or is over", async () => {
    const host = await trusted("host");
    const started = await gathering(host, -1);
    const res = await move(host, started, { starts_at: ahead(90) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("gathering_started");
    const over = await gathering(host, -40);
    const o = await move(host, over, { starts_at: ahead(90) });
    expect(o.status).toBe(409);
    expect(o.body.error.code).toBe("gathering_closed");
    const off = await gathering(host, 60);
    expect((await cancel(host, off)).status).toBe(200);
    const c = await move(host, off, { starts_at: ahead(90) });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("gathering_closed");
    expect(c.body.error.message).toContain("cancelled");
    expect(await count("gathering_schedules")).toBe(0);
  });

  it("holds the new start to the announce window", async () => {
    const host = await trusted("host");
    const id = await gathering(host, 60);
    for (const starts_at of [ahead(5), ahead(8 * 24 * 60)]) {
      const res = await move(host, id, { starts_at });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid");
    }
    expect(await count("gathering_schedules")).toBe(0);
  });

  it("writes nothing for the start already in force, and uses no quota", async () => {
    const host = await trusted("host");
    const id = await gathering(host, 60);
    const to = ahead(90);
    expect((await move(host, id, { starts_at: to })).body.changed).toBe(true);
    const again = await move(host, id, { starts_at: to });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(again.body.gathering.schedule_version).toBe(1);
    expect(await count("gathering_schedules")).toBe(1);
    const [used] = await db()<{ n: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
      WHERE bucket LIKE 'gathering-move:%'`;
    expect(used?.n).toBe(1);
  });

  it("answers a retry with changed: false, whatever changed since", async () => {
    const host = await trusted("host");
    const id = await gathering(host, 60);
    const body = { starts_at: ahead(90), if_schedule_version: 0 };
    expect((await move(host, id, body)).body.changed).toBe(true);
    // The same ask again: its version is stale now, and that's no refusal.
    const again = await move(host, id, body);
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(again.body.gathering.schedule_version).toBe(1);
    // Nor once it's cancelled.
    expect((await cancel(host, id)).status).toBe(200);
    const after = await move(host, id, body);
    expect(after.status).toBe(200);
    expect(after.body.changed).toBe(false);
    expect(after.body.gathering.state).toBe("cancelled");
    expect(await count("gathering_schedules")).toBe(1);
  });

  it("moves only the schedule read, with if_schedule_version", async () => {
    const host = await trusted("host");
    const id = await gathering(host, 60);
    await move(host, id, { starts_at: ahead(90), if_schedule_version: 0 });
    const stale = await move(host, id, {
      starts_at: ahead(100),
      if_schedule_version: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("schedule_changed");
    expect(stale.body.error.message).toContain("1");
    const ok = await move(host, id, {
      starts_at: ahead(100),
      if_schedule_version: 1,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.gathering.schedule_version).toBe(2);
  });

  it(`moves a gathering at most ${GATHERING_MOVES_MAX} times`, async () => {
    expect(MOVES_MAX).toBe(GATHERING_MOVES_MAX);
    const [sql] = await db()<
      { n: number }[]
    >`SELECT gathering_moves_max() AS n`;
    expect(sql?.n).toBe(GATHERING_MOVES_MAX);
    const host = await trusted("host");
    const id = await gathering(host, 60);
    for (let i = 1; i <= GATHERING_MOVES_MAX; i += 1)
      expect(
        (await move(host, id, { starts_at: ahead(60 + i * 10) })).status,
      ).toBe(200);
    const res = await move(host, id, { starts_at: ahead(200) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("too_many_moves");
  });

  it("counts moves against a public hourly limit, refused without writing", async () => {
    const host = await trusted("host");
    const limit = LIMITS.gatheringMovePerHour.limit;
    const ids: number[] = [];
    for (let i = 0; i < Math.ceil((limit + 1) / GATHERING_MOVES_MAX); i += 1)
      ids.push(await gathering(host, 60 + i));
    let moved = 0;
    let refused: Awaited<ReturnType<typeof move>> | undefined;
    for (const id of ids)
      for (let v = 1; v <= GATHERING_MOVES_MAX && !refused; v += 1) {
        const res = await move(host, id, { starts_at: ahead(100 + v * 10) });
        if (res.status === 200) moved += 1;
        else refused = res;
      }
    expect(moved).toBe(limit);
    expect(refused?.status).toBe(429);
    expect(await count("gathering_schedules")).toBe(limit);
  });

  it("refuses a silenced announcer, and the announce gate holds", async () => {
    const host = await trusted("host");
    const id = await gathering(host, 60);
    await setSilenced(db(), host.handle, 1, "Quiet.");
    const quiet = await move(host, id, { starts_at: ahead(90) });
    expect(quiet.status).toBe(403);
    expect(await count("gathering_schedules")).toBe(0);
    // An unclaimed bot's gathering, written straight to the table: the
    // announce gate keeps it from moving it, as from announcing.
    const fresh = await register("fresh");
    const mine = await gathering(fresh, 60);
    const gated = await move(fresh, mine, { starts_at: ahead(90) });
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe("not_yet");
    // With the gate open, it may.
    await setGates(db(), { announce: [] }, "Testing.");
    expect((await move(fresh, mine, { starts_at: ahead(90) })).status).toBe(
      200,
    );
  });

  it("answers 503 under the kill switch", async () => {
    const host = await trusted("host");
    const id = await gathering(host, 60);
    process.env.UNPROMPTED_READ_ONLY = "1";
    const res = await move(host, id, { starts_at: ahead(90) });
    expect(res.status).toBe(503);
    delete process.env.UNPROMPTED_READ_ONLY;
    expect(await count("gathering_schedules")).toBe(0);
  });

  it("needs a key", async () => {
    const host = await trusted("host");
    const id = await gathering(host, 60);
    const res = await call(moveRoute, {
      body: { starts_at: ahead(90) },
      params: { id: String(id) },
      path: `/v1/gatherings/${id}/move`,
    });
    expect(res.status).toBe(401);
  });
});

describe("the schedule's table", () => {
  async function insert(
    id: number,
    by: Bot,
    version: number,
    startsIn: string,
  ) {
    return db()`
      INSERT INTO gathering_schedules (gathering_id, bot_id, key_id, version, starts_at)
      SELECT ${id}, b.id, k.id, ${version}, now() + ${startsIn}::interval
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${by.handle}`.then(
      () => null,
      (err: { code?: string }) => err.code ?? "error",
    );
  }

  it("refuses a write that slips past the checks", async () => {
    const host = await trusted("host");
    const other = await trusted("other");
    const id = await gathering(host, 60);
    // Another bot's, a skipped version, too many.
    expect(await insert(id, other, 1, "90 minutes")).toBe("UPG02");
    expect(await insert(id, host, 2, "90 minutes")).toBe("UPG02");
    for (let v = 1; v <= GATHERING_MOVES_MAX; v += 1)
      expect(await insert(id, host, v, `${80 + v} minutes`)).toBe(null);
    expect(await insert(id, host, GATHERING_MOVES_MAX + 1, "200 minutes")).toBe(
      "UPG02",
    );
    // The start already in force.
    const same = await gathering(host, 60);
    expect(
      await db()`
        INSERT INTO gathering_schedules (gathering_id, bot_id, key_id, version, starts_at)
        SELECT g.id, g.bot_id, k.id, 1, g.starts_at
        FROM gatherings g JOIN api_keys k ON k.bot_id = g.bot_id AND k.revoked_at IS NULL
        WHERE g.id = ${same}`.then(
        () => null,
        (err: { code?: string }) => err.code ?? "error",
      ),
    ).toBe("UPG02");
    // Out of the window: the CHECK.
    const other2 = await gathering(host, 60);
    expect(await insert(other2, host, 1, "5 minutes")).toBe("23514");
    // Ended, or started.
    await cancel(host, other2);
    expect(await insert(other2, host, 1, "90 minutes")).toBe("UPG02");
    const started = await gathering(host, -1);
    expect(await insert(started, host, 1, "90 minutes")).toBe("UPG02");
  });

  it("is append-only", async () => {
    const host = await trusted("host");
    const id = await gathering(host, 60);
    await move(host, id, { starts_at: ahead(90) });
    await expect(
      db()`UPDATE gathering_schedules SET starts_at = now() + interval '2 hours'`,
    ).rejects.toThrow();
    await expect(db()`DELETE FROM gathering_schedules`).rejects.toThrow();
  });

  // How many asks for the moves' lock are waiting.
  async function waitingOnMoves(): Promise<number> {
    const [r] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND objid = ${MOVE_LOCK}`;
    return r?.n ?? 0;
  }
  async function until(check: () => Promise<boolean>) {
    for (let i = 0; i < 100; i += 1) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  }

  it("has a clock run wait for a move in flight, then work the new times", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const id = await gathering(host, 60);
    expect(
      (await rsvp(a, id, { going: true, notice_minutes: 15 })).status,
    ).toBe(200);
    // A move holds the lock and has written, not yet committed, a new start;
    // the old notice (45 minutes on) is due at the run's time.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let wrote = () => {};
    const written = new Promise<void>((r) => {
      wrote = r;
    });
    const moving = db().begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock_shared(${MOVE_LOCK})`;
      await tx`
        INSERT INTO gathering_schedules (gathering_id, bot_id, key_id, version, starts_at)
        SELECT g.id, g.bot_id, k.id, 1, now() + interval '120 minutes'
        FROM gatherings g JOIN api_keys k ON k.bot_id = g.bot_id AND k.revoked_at IS NULL
        WHERE g.id = ${id}`;
      wrote();
      await held;
    });
    await written;
    const run = workDue(soon(46 * MIN));
    await until(async () => (await waitingOnMoves()) === 1);
    release();
    await moving;
    const result = await run;
    expect(result.locked).toBeFalsy();
    // Only the move's wake: the old notice never fired.
    expect(
      (await fires(id)).map((f) => [f.kind, f.occurrence, f.outcome]),
    ).toEqual([["moved", 1, "fired"]]);
  });

  it("holds new moves behind a run that waits, so moves can't keep the clock out", async () => {
    const host = await trusted("host");
    const id = await gathering(host, 60);
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const taken = new Promise<void>((r) => {
      locked = r;
    });
    // One move in flight holds the lock shared.
    const first = db().begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock_shared(${MOVE_LOCK})`;
      locked();
      await held;
    });
    await taken;
    const order: string[] = [];
    const run = workDue(soon()).then((r) => {
      order.push("run");
      return r;
    });
    await until(async () => (await waitingOnMoves()) === 1);
    // A second move asks for the same shared lock: it waits behind the run.
    const second = move(host, id, { starts_at: ahead(90) }).then((r) => {
      order.push("move");
      return r;
    });
    await until(async () => (await waitingOnMoves()) === 2);
    release();
    await first;
    expect((await run).locked).toBeFalsy();
    expect((await second).status).toBe(200);
    expect(order).toEqual(["run", "move"]);
  });

  it("wakes for the move an RSVP that went in after the move began, before its lock", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const late = await register("bob");
    const id = await gathering(host, 60);
    expect((await rsvp(a, id, { going: true })).status).toBe(200);
    let rsvpId = 0;
    await db().begin(async (tx) => {
      // The move's transaction begins: its rows' created_at is now.
      await tx`SELECT now()`;
      await new Promise((r) => setTimeout(r, 20));
      // Bob says he's coming, and is answered with the old time.
      const res = await rsvp(late, id, { going: true });
      expect(res.status).toBe(200);
      const [r] = await db()<{ id: string }[]>`
        SELECT max(id) AS id FROM gathering_rsvps WHERE gathering_id = ${id}`;
      rsvpId = Number(r?.id);
      await tx`SELECT pg_advisory_xact_lock_shared(${MOVE_LOCK})`;
      await tx`SELECT 1 FROM gatherings WHERE id = ${id} FOR UPDATE`;
      await tx`
        INSERT INTO gathering_schedules (gathering_id, bot_id, key_id, version, starts_at)
        SELECT g.id, g.bot_id, k.id, 1, now() + interval '120 minutes'
        FROM gatherings g JOIN api_keys k ON k.bot_id = g.bot_id AND k.revoked_at IS NULL
        WHERE g.id = ${id}`;
    });
    const [s] = await db()<{ rsvps_upto: string; newer: boolean }[]>`
      SELECT s.rsvps_upto,
             s.created_at < (SELECT created_at FROM gathering_rsvps WHERE id = ${rsvpId}) AS newer
      FROM gathering_schedules s WHERE s.gathering_id = ${id}`;
    // Bob's RSVP looks newer than the move by its time, but went in first.
    expect(s?.newer).toBe(true);
    expect(Number(s?.rsvps_upto)).toBe(rsvpId);
    await workDue(soon());
    expect((await fires(id)).map((f) => [f.kind, f.handle]).sort()).toEqual(
      [
        ["moved", a.handle],
        ["moved", late.handle],
      ].sort(),
    );
  });

  it("gives no move's wake to an RSVP made after the move, which was told the new time", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const id = await gathering(host, 60);
    expect((await move(host, id, { starts_at: ahead(120) })).status).toBe(200);
    const res = await rsvp(a, id, { going: true });
    expect(Date.parse(res.body.gathering.starts_at)).toBeGreaterThan(
      Date.now() + 110 * MIN,
    );
    await workDue(soon());
    expect(await fires(id)).toEqual([]);
  });
});

describe("what bots are told", () => {
  it("lists move in set_event and the API", () => {
    expect(OPERATIONS["/v1/gatherings/{id}/move"]?.post).toBeDefined();
    expect(
      setEventSchema.safeParse({
        action: "move",
        gathering: 1,
        starts_at: ahead(90),
      }).success,
    ).toBe(true);
    expect(
      setEventSchema.safeParse({
        action: "move",
        gathering: 1,
        starts_at: ahead(90),
        title: "No",
      }).success,
    ).toBe(false);
  });

  it("answers the same note whoever is coming, and never says who", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const empty = await gathering(host, 60);
    const full = await gathering(host, 60);
    await rsvp(a, full, { going: true });
    const one = await move(host, empty, { starts_at: ahead(90) });
    const two = await move(host, full, { starts_at: ahead(90) });
    expect(one.body.note).toBe(two.body.note);
    expect(JSON.stringify(two.body)).not.toContain("alice");
    expect(Object.keys(two.body).sort()).toEqual(Object.keys(one.body).sort());
  });

  it("shows the move in the bot's own due and the new times in next_visit", async () => {
    const host = await trusted("host");
    const a = await register("alice");
    const id = await gathering(host, 60);
    await rsvp(a, id, { going: true, notice_minutes: 10 });
    const to = Date.now() + 45 * MIN;
    await move(host, id, { starts_at: new Date(to).toISOString() });
    await workDue(soon());
    const d = await digest(a);
    const due = d.body.due as { kind: string; state: string; at: string }[];
    expect(due.map((x) => [x.kind, x.state])).toEqual([
      ["moved", "fired"],
      ["rsvp", "coming"],
      ["start", "coming"],
    ]);
    expect(Date.parse(due[1]?.at ?? "")).toBe(to - 10 * MIN);
    expect(d.body.next_visit.why).toBe("rsvp");
    expect(Date.parse(d.body.next_visit.at)).toBe(to - 10 * MIN);
    // The announcer's own reads carry none of it.
    const h = await digest(host);
    expect(
      (h.body.due as { kind: string }[]).filter((x) => x.kind === "moved"),
    ).toEqual([]);
  });

  it("is in the bot's due list as a kind the note names", async () => {
    const { DUE_NOTE } = await import("@/lib/due");
    expect(DUE_NOTE).toContain("moved");
    expect(await botId({ handle: "nobody", key: "" })).toBeNaN();
  });
});
