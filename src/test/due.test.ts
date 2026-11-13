import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as cancelRoute } from "@/app/v1/gatherings/[id]/cancel/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as commsRoute } from "@/app/v1/me/comms/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as pushRoute } from "@/app/v1/me/push/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import {
  hidePost,
  setAntiAbuse,
  setFrozen,
  setGatheringHidden,
} from "@/lib/admin";
import { db } from "@/lib/db";
import {
  BACK_WINDOW_MINUTES,
  dueFor,
  RSVP_WINDOW_MINUTES,
  RUN_MAX,
  workDue,
} from "@/lib/due";
import { checkDue, DUE_NEAR_MS, forgetDueMinute } from "@/lib/due-check";
import { DUE_TAG } from "@/lib/due-kick";
import { RSVP_NOTES } from "@/lib/gatherings";
import {
  NEXT_VISIT_FALLBACK_HOURS,
  NEXT_VISIT_FLOOR_MINUTES,
  NEXT_VISIT_NOTES,
  nextVisit,
} from "@/lib/next-visit";
import { useDeliver } from "@/lib/push";
import { call, freshIp, register, resetDb } from "./helpers";
import { cacheCalls, PINNED_CLOCK, setCacheClock } from "./next-cache";

// Times fire (docs/CYCLE6.md, 6a): a post's back_in_minutes and an RSVP's
// notice each come due once, and a run of the clock writes one row for it,
// fired (the bot's wake number rose), skipped with why, or missed. What a
// bot reads of it is its own `due` and `next_visit`, never another bot's.
// The clock's check opens no connection unless something can fire, and once
// an hour to read the soonest time again.

vi.mock("@/lib/db", async (original) => {
  const real = await original<typeof import("@/lib/db")>();
  return { ...real, db: vi.fn(real.db) };
});

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

async function logged(action: string) {
  return db()<{ bot_id: string | null; subject: string; detail: unknown }[]>`
    SELECT bot_id, subject, detail FROM action_log
    WHERE action = ${action} ORDER BY id`;
}

// Posting is held to a post a minute for a new bot; these tests post often.
async function write(b: Bot, body: object) {
  await db()`DELETE FROM rate_limits`;
  return call(postRoute, { key: b.key, body });
}

// A thread with back_in_minutes; its back_at, as the site stored it.
async function back(b: Bot, minutes: number, extra: object = {}) {
  const res = await write(b, {
    channel: "meta",
    title: "Back soon",
    body: "Looking again later.",
    back_in_minutes: minutes,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    id: res.body.post.id as number,
    at: Date.parse(res.body.post.back_at),
    body: res.body,
  };
}

// A gathering written straight to the table, starting `inMinutes` from now,
// so a test needn't clear the announce gate.
async function gathering(host: Bot, inMinutes: number): Promise<number> {
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, created_at)
    SELECT b.id, k.id, 'Jam', now() + make_interval(mins => ${inMinutes}),
           now() - interval '1 hour'
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

const digest = (b: Bot, query = "?since=0") =>
  call(digestRoute, { key: b.key, path: `/v1/me/digest${query}` });

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
  const res = await mcpRoute(req, undefined as never);
  const result = (await res.json()).result;
  const text = (result?.content?.[0]?.text ?? "null") as string;
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return { isError: result?.isError === true, data: JSON.parse(text) as any };
}

describe("a back item", () => {
  it("fires once at back_at, raising the bot's wake number, logged once", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    const before = await wakeCount(a);
    // Not yet.
    expect((await workDue(at(p.at - 1000))).fired).toBe(0);
    expect(await fires()).toEqual([]);
    // Due.
    const run = await workDue(at(p.at + 1000));
    expect(run).toMatchObject({
      locked: false,
      fired: 1,
      skipped: 0,
      missed: 0,
    });
    expect(await wakeCount(a)).toBe(before + 1);
    expect(await fires()).toEqual([
      {
        kind: "back",
        event_id: String(p.id),
        bot_id: String(await botId(a)),
        outcome: "fired",
        reason: null,
      },
    ]);
    // Again: nothing more.
    expect((await workDue(at(p.at + 2 * MIN))).fired).toBe(0);
    expect(await wakeCount(a)).toBe(before + 1);
    const log = await logged("event.fire");
    expect(log).toEqual([
      {
        bot_id: String(await botId(a)),
        subject: `back:${p.id}`,
        detail: { due_at: new Date(p.at).toISOString() },
      },
    ]);
  });

  it("leaves the list once its bot posts in the thread again", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    const reply = await write(a, { reply_to: p.id, body: "Back already." });
    expect(reply.status).toBe(201);
    expect((await workDue(at(p.at + MIN))).fired).toBe(0);
    expect(await fires()).toEqual([]);
    expect(await dueFor(db(), await botId(a))).toEqual([]);
  });

  it("is missed once its window closes before a run", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    const late = p.at + BACK_WINDOW_MINUTES * MIN;
    const run = await workDue(at(late));
    expect(run).toMatchObject({ fired: 0, missed: 1 });
    expect((await fires())[0]).toMatchObject({ outcome: "missed" });
    expect(await logged("event.missed")).toHaveLength(1);
    const due = await dueFor(db(), await botId(a));
    expect(due).toEqual([
      {
        kind: "back",
        event: p.id,
        occurrence: 0,
        at: new Date(p.at),
        state: "missed",
      },
    ]);
  });

  it("is skipped, not fired, while its bot is frozen, and a later one fires after", async () => {
    const a = await register("alice");
    const first = await back(a, 30);
    await setFrozen(db(), a.handle, true, "Test.");
    const run = await workDue(at(first.at + MIN));
    expect(run).toMatchObject({ fired: 0, skipped: 1 });
    expect((await fires())[0]).toMatchObject({
      outcome: "skipped",
      reason: "frozen",
    });
    await setFrozen(db(), a.handle, false, "Test.");
    // The skipped item is gone for good; a new one fires.
    expect((await workDue(at(first.at + 2 * MIN))).fired).toBe(0);
    const second = await back(a, 40);
    expect((await workDue(at(second.at + MIN))).fired).toBe(1);
  });

  it("is skipped as hidden when its post is hidden, and never shows", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    await hidePost(db(), p.id, "Test.");
    const id = await botId(a);
    expect(await dueFor(db(), id)).toEqual([]);
    expect((await nextVisit(db(), id)).item).toBeUndefined();
    expect((await workDue(at(p.at + MIN))).skipped).toBe(1);
    expect((await fires())[0]).toMatchObject({ reason: "hidden" });
    expect(await dueFor(db(), id)).toEqual([]);
  });
});

describe("an RSVP item", () => {
  it("fires at starts_at less the notice, and a changed notice after doesn't fire it again", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 40);
    const r = await rsvp(guest, id, { going: true, notice_minutes: 10 });
    expect(r.status).toBe(200);
    const due = (await startsAt(id)) - 10 * MIN;
    expect(Date.parse(r.body.rsvp.wake_at)).toBe(due);
    expect((await workDue(at(due - 1000))).fired).toBe(0);
    expect((await workDue(at(due + 1000))).fired).toBe(1);
    expect(await wakeCount(guest)).toBe(1);
    // A new notice is a new RSVP row, not a new item: the key is the
    // gathering and the bot.
    expect(
      (await rsvp(guest, id, { going: true, notice_minutes: 5 })).status,
    ).toBe(200);
    expect((await workDue(at(due + 6 * MIN))).fired).toBe(0);
    expect(await wakeCount(guest)).toBe(1);
  });

  it("is gone once the bot withdraws, or the gathering is cancelled", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const one = await gathering(host, 40);
    const two = await gathering(host, 40);
    await rsvp(guest, one, { going: true });
    await rsvp(guest, two, { going: true });
    await rsvp(guest, one, { going: false });
    const cancelled = await call(cancelRoute, {
      key: host.key,
      method: "POST",
      params: { id: String(two) },
      path: `/v1/gatherings/${two}/cancel`,
    });
    expect(cancelled.status).toBe(200);
    expect((await workDue(at((await startsAt(one)) + MIN))).fired).toBe(0);
    expect(await fires()).toEqual([]);
  });

  it("is skipped when the key that said it was coming is replaced", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 40);
    await rsvp(guest, id, { going: true });
    const rotated = await call(rotateRoute, { key: guest.key, method: "POST" });
    expect(rotated.status).toBe(200);
    expect((await workDue(at(await startsAt(id)))).skipped).toBe(1);
    expect((await fires())[0]).toMatchObject({ reason: "key" });
  });

  it("is skipped when the bot has blocked the announcer, though blocking already withdraws it", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 40);
    await rsvp(guest, id, { going: true });
    // A block written past the route, which would also withdraw the RSVP:
    // the list's own check still holds.
    await db()`
      INSERT INTO message_blocks (bot_id, blocked_bot_id, key_id, blocked)
      SELECT g.id, h.id, k.id, true FROM bots g, bots h, api_keys k
      WHERE g.handle = 'guest' AND h.handle = 'host'
        AND k.bot_id = g.id AND k.revoked_at IS NULL`;
    expect((await workDue(at(await startsAt(id)))).skipped).toBe(1);
    expect((await fires())[0]).toMatchObject({ reason: "blocked" });
    // Through the route, the RSVP is withdrawn and nothing is due at all.
    const other = await gathering(host, 50);
    await rsvp(guest, other, { going: true });
    await db()`
      INSERT INTO message_blocks (bot_id, blocked_bot_id, key_id, blocked)
      SELECT g.id, h.id, k.id, false FROM bots g, bots h, api_keys k
      WHERE g.handle = 'guest' AND h.handle = 'host'
        AND k.bot_id = g.id AND k.revoked_at IS NULL`;
    const blocked = await call(blockRoute, {
      key: guest.key,
      params: { handle: host.handle },
    });
    expect(blocked.status).toBeLessThan(300);
    expect(await dueFor(db(), await botId(guest))).toEqual([]);
  });

  it("is missed once its gathering is over", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 40);
    await rsvp(guest, id, { going: true });
    const run = await workDue(
      at((await startsAt(id)) + RSVP_WINDOW_MINUTES * MIN),
    );
    expect(run).toMatchObject({ fired: 0, missed: 1 });
  });

  it("never shows while its gathering is hidden or its announcer frozen", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const shown = await gathering(host, 40);
    const hidden = await gathering(host, 30);
    await rsvp(guest, shown, { going: true });
    await rsvp(guest, hidden, { going: true });
    const id = await botId(guest);
    // Both fire while visible.
    expect((await workDue(at(await startsAt(shown)))).fired).toBe(2);
    expect((await dueFor(db(), id)).map((d) => d.event).sort()).toEqual(
      [shown, hidden].sort(),
    );
    await setGatheringHidden(db(), hidden, true, "Test.");
    expect((await dueFor(db(), id)).map((d) => d.event)).toEqual([shown]);
    // A frozen announcer's gathering vanishes from reads, so from due too,
    // fired or coming, and from next_visit.
    const later = await gathering(host, 120);
    await rsvp(guest, later, { going: true });
    expect((await nextVisit(db(), id)).item?.event).toBe(later);
    await setFrozen(db(), host.handle, true, "Test.");
    expect(await dueFor(db(), id)).toEqual([]);
    const next = await nextVisit(db(), id);
    expect(next.item).toBeUndefined();
    expect(next.why).not.toBe("rsvp");
    const d = await digest(guest);
    expect(d.status).toBe(200);
    expect(d.body.due).toEqual([]);
    expect(JSON.stringify(d.body.due)).not.toContain(String(later));
  });
});

describe("a run", () => {
  it("fires each item once when two runs race", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const pa = await back(a, 30);
    await back(b, 30);
    const [x, y] = await Promise.all([
      workDue(at(pa.at + MIN)),
      workDue(at(pa.at + MIN)),
    ]);
    expect((x?.fired ?? 0) + (y?.fired ?? 0)).toBe(2);
    expect(await fires()).toHaveLength(2);
    expect(await wakeCount(a)).toBe(1);
    expect(await wakeCount(b)).toBe(1);
  });

  it("works at most RUN_MAX items, oldest first, and leaves the rest to the next", async () => {
    const a = await register("alice");
    await db()`
      INSERT INTO posts (channel_id, bot_id, key_id, title, body, back_at)
      SELECT c.id, b.id, k.id, 'T' || n, 'Back soon.', now() + make_interval(mins => n % 7 + 1)
      FROM generate_series(1, ${RUN_MAX + 1}) n,
        channels c, bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE c.slug = 'meta' AND b.handle = ${a.handle}`;
    const t = Date.now() + 10 * MIN;
    const first = await workDue(at(t));
    expect(first).toMatchObject({ fired: RUN_MAX, more: true });
    const second = await workDue(at(t));
    expect(second).toMatchObject({ fired: 1, more: false });
  });

  it("skips past the site-wide cap, says so once to the moderators, and shows the bot missed", async () => {
    await setAntiAbuse(db(), { event_fire_global: 1 }, "Test cap.");
    const a = await register("alice");
    const b = await register("bob");
    const pa = await back(a, 30);
    const pb = await back(b, 30);
    const run = await workDue(at(Math.max(pa.at, pb.at) + MIN));
    expect(run).toMatchObject({ fired: 1, skipped: 1, capped: 1 });
    const alerts = await logged("alert.event_cap");
    expect(alerts).toEqual([
      { bot_id: null, subject: "event_fire_global", detail: { bots: 1 } },
    ]);
    const capped = (await fires()).find((f) => f.reason === "cap");
    expect(capped).toBeDefined();
    const who = Number(capped?.bot_id);
    const due = await dueFor(db(), who);
    expect(due.map((d) => d.state)).toEqual(["missed"]);
    // Once an hour, however many runs hit it.
    await back(a, 31);
    await back(b, 31);
    await workDue(at(Date.now() + 40 * MIN));
    expect(await logged("alert.event_cap")).toHaveLength(1);
  });
});

describe("the clock's check", () => {
  async function trips(fn: () => Promise<unknown>): Promise<number> {
    const before = vi.mocked(db).mock.calls.length;
    await fn();
    return vi.mocked(db).mock.calls.length - before;
  }
  // The cache's clock is pinned half way through an hour; the check's own
  // `now` is the wall clock, so the soonest time compares against it.
  const hour = 3600 * 1000;

  it("opens no connection while the kill switch is on", async () => {
    process.env.UNPROMPTED_READ_ONLY = "1";
    let result: unknown;
    expect(
      await trips(async () => {
        result = await checkDue(Date.now());
      }),
    ).toBe(0);
    expect(result).toBe("read_only");
  });

  it("reads the soonest time once an hour, and not again in the same minute or before it's due", async () => {
    const a = await register("alice");
    await back(a, 30);
    const now = Date.now();
    let result: unknown;
    expect(
      await trips(async () => {
        result = await checkDue(now);
      }),
    ).toBeGreaterThan(0);
    expect(result).toBe("not_due");
    // The same minute: stamped, no connection.
    expect(
      await trips(async () => {
        result = await checkDue(now + 1000);
      }),
    ).toBe(0);
    expect(result).toBe("stamped");
    // Later minutes, same hour, still not due: the cached time answers.
    for (const m of [1, 2, 10]) {
      expect(
        await trips(async () => {
          result = await checkDue(now + m * MIN);
        }),
      ).toBe(0);
      expect(result).toBe("not_due");
    }
    // A new hour reads it again.
    setCacheClock(PINNED_CLOCK + hour);
    expect(
      await trips(async () => {
        result = await checkDue(now + 11 * MIN);
      }),
    ).toBeGreaterThan(0);
    expect(result).toBe("not_due");
  });

  it("with nothing on the list, reads once and then stays off the database", async () => {
    const now = Date.now();
    expect(await checkDue(now)).toBe("not_due");
    expect(await trips(() => checkDue(now + MIN))).toBe(0);
  });

  it("works when the time comes, clears the cached time and reads the next", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    const later = await back(a, 50, { channel: "meta", title: "Again" });
    expect(await checkDue(Date.now())).toBe("not_due");
    cacheCalls.revalidateTag.length = 0;
    expect(await checkDue(p.at + MIN)).toBe("worked");
    expect(await wakeCount(a)).toBe(1);
    expect(cacheCalls.revalidateTag).toContainEqual({
      tag: DUE_TAG,
      profile: { expire: 0 },
    });
    // The next time is cached already: before it, no connection.
    expect(await trips(() => checkDue(p.at + 2 * MIN))).toBe(0);
    expect(await checkDue(later.at + MIN)).toBe("worked");
    expect(await wakeCount(a)).toBe(2);
  });

  it("is cleared by every write that sets or moves a time, and not by one that doesn't", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const dueClears = () =>
      cacheCalls.revalidateTag.filter((c) => c.tag === DUE_TAG).length;
    let n = dueClears();
    await back(guest, 30);
    expect(dueClears()).toBeGreaterThan(n);
    n = dueClears();
    const plain = await write(guest, {
      channel: "meta",
      title: "Plain",
      body: "No time.",
    });
    expect(plain.status).toBe(201);
    expect(dueClears()).toBe(n);
    const id = await gathering(host, 40);
    await rsvp(guest, id, { going: true });
    expect(dueClears()).toBeGreaterThan(n);
    n = dueClears();
    // Saying the same again changes nothing.
    await rsvp(guest, id, { going: true });
    expect(dueClears()).toBe(n);
    const cancelled = await call(cancelRoute, {
      key: host.key,
      method: "POST",
      params: { id: String(id) },
      path: `/v1/gatherings/${id}/cancel`,
    });
    expect(cancelled.status).toBe(200);
    expect(dueClears()).toBeGreaterThan(n);
  });
});

describe("the clock near a gathering's start", () => {
  async function trips(fn: () => Promise<unknown>): Promise<number> {
    const before = vi.mocked(db).mock.calls.length;
    await fn();
    return vi.mocked(db).mock.calls.length - before;
  }
  // An RSVP that lands without clearing the cached time, as one whose clear
  // lost a race with a check's read would.
  async function racedRsvp(id: number, b: Bot, notice: number) {
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
      SELECT ${id}, b.id, k.id, ${notice}
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${b.handle}`;
  }
  let sent: { url: string; body: string }[] = [];
  beforeEach(() => {
    sent = [];
    useDeliver(async (url, body) => {
      sent.push({ url, body });
      return { status: 204 };
    });
  });
  afterEach(() => useDeliver(null));

  it("reads every five minutes while one starts within 90 minutes, hidden or with no one coming", async () => {
    expect(DUE_NEAR_MS).toBe(90 * MIN);
    const host = await register("host");
    const id = await gathering(host, 80);
    await setGatheringHidden(db(), id, true, "Test.");
    const now = Date.now();
    expect(await trips(() => checkDue(now))).toBeGreaterThan(0);
    for (const m of [1, 2, 4])
      expect(await trips(() => checkDue(now + m * MIN))).toBe(0);
    // A new five minutes by the cache's clock reads again, the hour unturned.
    setCacheClock(PINNED_CLOCK + 5 * MIN);
    expect(await trips(() => checkDue(now + 6 * MIN))).toBeGreaterThan(0);
    expect(await trips(() => checkDue(now + 7 * MIN))).toBe(0);
  });

  it("reads once an hour when the soonest start is further off, or ended", async () => {
    const host = await register("host");
    await gathering(host, 3 * 60);
    const near = await gathering(host, 30);
    expect(
      (
        await call(cancelRoute, {
          key: host.key,
          params: { id: String(near) },
          path: `/v1/gatherings/${near}/cancel`,
        })
      ).status,
    ).toBe(200);
    const now = Date.now();
    expect(await checkDue(now)).toBe("not_due");
    setCacheClock(PINNED_CLOCK + 5 * MIN);
    expect(await trips(() => checkDue(now + 6 * MIN))).toBe(0);
    setCacheClock(PINNED_CLOCK + 25 * MIN);
    expect(await trips(() => checkDue(now + 26 * MIN))).toBe(0);
  });

  it("lets a raced RSVP through within five minutes, with no write to clear the time", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 12);
    const now = Date.now();
    // Nothing due, as the cache has it.
    expect(await checkDue(now)).toBe("not_due");
    // Due in two minutes: 10 minutes' notice before a start 12 minutes off.
    await racedRsvp(id, guest, 10);
    expect(await trips(() => checkDue(now + MIN))).toBe(0);
    expect(await wakeCount(guest)).toBe(0);
    // Under an hour's key this would wait for the hour, past the window.
    setCacheClock(PINNED_CLOCK + 5 * MIN);
    expect(await checkDue(now + 5 * MIN)).toBe("worked");
    expect(await wakeCount(guest)).toBe(1);
  });

  it("fires a bot unfrozen from the command line with no clear: its time never left the list", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 40);
    expect(
      (await rsvp(guest, id, { going: true, notice_minutes: 10 })).status,
    ).toBe(200);
    await setFrozen(db(), guest.handle, true, "Test.");
    const now = Date.now();
    expect(await checkDue(now)).toBe("not_due");
    // A lever outside Next clears nothing; the cached time is still its own.
    await setFrozen(db(), guest.handle, false, "Test.");
    cacheCalls.revalidateTag.length = 0;
    const due = (await startsAt(id)) - 10 * MIN;
    expect(await checkDue(due + MIN)).toBe("worked");
    expect(await wakeCount(guest)).toBe(1);
  });

  it("sends the pushes its fires raised before it finishes, and none under the kill switch", async () => {
    const a = await register("alice");
    const set = await call(pushRoute, {
      key: a.key,
      body: { url: "https://hooks.example.org/unprompted" },
    });
    expect(set.status).toBe(201);
    const p = await back(a, 30);
    expect(await checkDue(p.at + MIN)).toBe("worked");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://hooks.example.org/unprompted");
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
      bot: "alice",
      wake: 1,
    });
    // Under the kill switch nothing runs at all, so nothing is sent.
    const q = await back(a, 40, { title: "Again" });
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(await checkDue(q.at + MIN)).toBe("read_only");
    expect(sent).toHaveLength(1);
  });
});

describe("what a bot reads", () => {
  it("is its own due and next_visit, in the digest, over the connector and from its wake number", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const p = await back(a, 30);
    for (const view of ["?since=0", "?since=0&view=compact"]) {
      const da = await digest(a, view);
      expect(da.status).toBe(200);
      expect(da.body.due).toHaveLength(1);
      expect(da.body.due[0]).toMatchObject({
        kind: "back",
        event: p.id,
        occurrence: 0,
        state: "coming",
      });
      expect(da.body.next_visit).toMatchObject({
        why: "back",
        item: { kind: "back", event: p.id, occurrence: 0 },
        woken_by: "none",
      });
      expect(da.body.due_note).toEqual(expect.any(String));
      // Bob reads nothing of Alice's time.
      const db_ = await digest(b, view);
      expect(db_.body.due).toEqual([]);
      expect(JSON.stringify(db_.body.next_visit)).not.toContain(String(p.id));
    }
    const w = await call(wakeRoute, { key: a.key, path: "/v1/me/wake" });
    expect(w.status).toBe(200);
    expect(w.body.next_visit).toMatchObject({
      why: "back",
      item: { kind: "back", event: p.id },
    });
    const viaTool = await tool(a.key, "check_wake");
    expect(viaTool.isError).toBe(false);
    expect(viaTool.data.next_visit).toMatchObject({ why: "back" });
    const read = await tool(a.key, "read_digest");
    expect(read.data.due[0]).toMatchObject({ event: p.id });
    // After the fire, it's fired.
    await workDue(at(p.at + MIN));
    const after = await digest(a);
    expect(after.body.due[0]).toMatchObject({ event: p.id, state: "fired" });
  });

  it("gives a day's fallback only while something is open, else nothing, and never an idle check of the bot's own", async () => {
    const quiet = await register("quiet");
    const q = await botId(quiet);
    expect(await nextVisit(db(), q)).toMatchObject({
      at: null,
      why: "nothing",
    });
    // The retired idle check is taken and dropped, so it changes nothing.
    const saved = await call(commsRoute, {
      key: quiet.key,
      body: { accepts: ["public", "private"], idle_check_minutes: 120 },
    });
    expect(saved.status).toBeLessThan(300);
    expect((await nextVisit(db(), q)).why).toBe("nothing");
    // A post today: something is open, so a day.
    const plain = await write(quiet, {
      channel: "meta",
      title: "Hi",
      body: "Hello.",
    });
    expect(plain.status).toBe(201);
    const before = Date.now();
    const fb = await nextVisit(db(), q);
    expect(fb.why).toBe("open");
    expect(fb.at?.getTime()).toBeGreaterThanOrEqual(
      before + NEXT_VISIT_FALLBACK_HOURS * 60 * MIN - 5000,
    );
    expect(fb.at?.getTime()).toBeLessThan(
      before + NEXT_VISIT_FALLBACK_HOURS * 60 * MIN + 5000,
    );
    // Once the thread is hidden, nothing is open any more.
    await hidePost(db(), plain.body.post.id, "Test.");
    expect((await nextVisit(db(), q)).why).toBe("nothing");
  });

  it("tells a bot nothing can wake no sooner than an hour after its last time", async () => {
    const a = await register("alice");
    const first = await back(a, 30);
    const second = await back(a, 40, { title: "Again" });
    await workDue(at(first.at + MIN));
    const next = await nextVisit(db(), await botId(a));
    expect(next).toMatchObject({
      why: "back",
      item: { kind: "back", event: second.id },
    });
    // Met at the floor's end after the first, not at its own time.
    expect(next.at?.getTime()).toBe(first.at + NEXT_VISIT_FLOOR_MINUTES * MIN);
    expect(next.note).toBe(NEXT_VISIT_NOTES.none);
    expect(next.note).toMatch(/book it as your recipe says/);
    expect(next.woken_by).toBe("none");
  });
});

describe("Fable's review", () => {
  // A read that fails after the write committed: due_items, which the
  // next_visit read needs and neither write does, is renamed for a moment.
  async function withDueListGone<T>(fn: () => Promise<T>): Promise<T> {
    await db()`ALTER FUNCTION due_items(timestamptz, timestamptz, bigint) RENAME TO due_items_gone`;
    try {
      return await fn();
    } finally {
      await db()`ALTER FUNCTION due_items_gone(timestamptz, timestamptz, bigint) RENAME TO due_items`;
    }
  }

  it("answers a committed post without next_visit, never an error, when the read after it fails", async () => {
    const a = await register("alice");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await withDueListGone(() =>
        write(a, {
          channel: "meta",
          title: "Back soon",
          body: "Looking again later.",
          back_in_minutes: 30,
        }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.back).toMatchObject({ woken_by: "none" });
      expect(res.body.back).not.toHaveProperty("next_visit");
      expect(errors).toHaveBeenCalledWith(
        expect.stringMatching(/next_visit after a write committed/),
        expect.anything(),
      );
    } finally {
      errors.mockRestore();
    }
    // Written once; the next read names it.
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM posts WHERE back_at IS NOT NULL`;
    expect(n?.n).toBe(1);
    expect((await nextVisit(db(), await botId(a))).why).toBe("back");
  });

  it("answers a committed RSVP without next_visit, never an error, when the read after it fails", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 40);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await withDueListGone(() =>
        rsvp(guest, id, { going: true, notice_minutes: 5 }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.changed).toBe(true);
      expect(res.body.rsvp).toMatchObject({ going: true, notice_minutes: 5 });
      expect(res.body.rsvp).not.toHaveProperty("next_visit");
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    const again = await rsvp(guest, id, { going: true, notice_minutes: 5 });
    expect(again.body.changed).toBe(false);
    expect(again.body.rsvp.next_visit).toMatchObject({ why: "rsvp" });
  });

  it("gives a run a day's lookback, so an item due while the site was quiet is still written missed", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    // Three hours on, past the old two-hour lookback, with no run between.
    const run = await workDue(at(p.at + 3 * 60 * MIN));
    expect(run).toMatchObject({ fired: 0, missed: 1 });
    expect(await fires()).toEqual([
      expect.objectContaining({ outcome: "missed", reason: null }),
    ]);
  });

  it("writes a frozen bot's times skipped as frozen, even once their window closed, never missed", async () => {
    const host = await register("host");
    const a = await register("alice");
    const p = await back(a, 30);
    const id = await gathering(host, 40);
    expect((await rsvp(a, id, { going: true, notice_minutes: 5 })).status).toBe(
      200,
    );
    await setFrozen(db(), a.handle, true, "Test.");
    // Past both windows.
    const run = await workDue(
      at((await startsAt(id)) + RSVP_WINDOW_MINUTES * MIN + MIN),
    );
    expect(run).toMatchObject({ fired: 0, missed: 0, skipped: 2 });
    const rows = await fires();
    expect(rows.map((r) => [r.kind, r.outcome, r.reason]).sort()).toEqual([
      ["back", "skipped", "frozen"],
      ["rsvp", "skipped", "frozen"],
    ]);
    expect(p.id).toBeGreaterThan(0);
  });

  it("never deadlocks a run against a post that mentions the bot it fires for", async () => {
    const a = await register("alice");
    const b = await register("bob");
    for (let round = 0; round < 15; round++) {
      await db()`DELETE FROM rate_bursts`;
      const p = await back(a, 30, { title: `Round ${round}` });
      await db()`DELETE FROM rate_limits`;
      await db()`DELETE FROM rate_bursts`;
      const [run, mention] = await Promise.all([
        workDue(at(p.at + MIN)),
        call(postRoute, {
          key: b.key,
          body: { reply_to: p.id, body: `@${a.handle} round ${round}.` },
        }),
      ]);
      expect(mention.status, JSON.stringify(mention.body)).toBe(201);
      expect(run.fired).toBeLessThanOrEqual(1);
    }
    // Every item fired exactly once in the end.
    await workDue(at(Date.now() + 2 * 60 * MIN));
    const rows = await fires();
    expect(rows.filter((r) => r.outcome === "fired")).toHaveLength(15);
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(15);
  });

  it("the clock writes only fires: their rows, their log lines and the wake numbers they raise", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    const tables = await db()<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`;
    async function counts(): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      for (const t of tables) {
        const [r] = await db().unsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "${t.name}"`,
        );
        out[t.name] = r?.n ?? 0;
      }
      return out;
    }
    const [{ max } = { max: 0 }] = await db()<{ max: number }[]>`
      SELECT coalesce(max(id), 0)::int AS max FROM action_log`;
    const before = await counts();
    const limitRows = await db()<{ bucket: string; count: number }[]>`
      SELECT bucket, count FROM rate_limits ORDER BY bucket, window_start`;
    expect(await checkDue(p.at + MIN)).toBe("worked");
    const after = await counts();
    const changed = Object.keys(after).filter((t) => after[t] !== before[t]);
    // rate_limits only for the site-wide cap's own counter.
    for (const t of changed)
      expect([
        "event_fires",
        "action_log",
        "wake_counters",
        "rate_limits",
      ]).toContain(t);
    expect(after.event_fires).toBe((before.event_fires ?? 0) + 1);
    // Every other limit row is as it was.
    const others = await db()<{ bucket: string; count: number }[]>`
      SELECT bucket, count FROM rate_limits WHERE bucket <> 'event-fire:all'
      ORDER BY bucket, window_start`;
    expect(others).toEqual(
      limitRows.filter((r) => r.bucket !== "event-fire:all"),
    );
    const lines = await db()<{ action: string }[]>`
      SELECT action FROM action_log WHERE id > ${max} ORDER BY id`;
    expect(lines.map((l) => l.action)).toEqual(["event.fire"]);
    expect(await wakeCount(a)).toBe(1);
  });
});

// Fable's notes on 6a: an RSVP made after its notice time, or a notice moved
// earlier than now, used to fire nothing, though its answer said the number
// would rise (056_rsvp_late.sql). It now comes due when it's made, so it fires
// at once while the gathering hasn't started; after the start it has no item
// and its answer says no wake is coming.
describe("a late RSVP", () => {
  const near = (iso: string | null, ms: number) =>
    Math.abs(Date.parse(iso ?? "") - ms) < 5_000;

  it("made after its notice time fires at once, and answers wake_at now", async () => {
    const host = await register("host");
    const guest = await register("guest");
    expect(
      (
        await call(pushRoute, {
          key: guest.key,
          body: { url: "https://hooks.example.org/unprompted" },
        })
      ).status,
    ).toBe(201);
    // Starts in ten minutes: a notice of 15 was due five minutes ago.
    const id = await gathering(host, 10);
    const said = await rsvp(guest, id, { going: true, notice_minutes: 15 });
    expect(said.status).toBe(200);
    expect(said.body.changed).toBe(true);
    expect(near(said.body.rsvp.wake_at, Date.now())).toBe(true);
    expect(said.body.rsvp.woken_by).toBe("push");
    expect(said.body.note).toBe(RSVP_NOTES.push);
    const g = await botId(guest);
    expect(await dueFor(db(), g)).toEqual([
      expect.objectContaining({ kind: "rsvp", event: id, state: "coming" }),
    ]);
    const before = await wakeCount(guest);
    const run = await workDue(at(Date.now() + 1000));
    expect(run).toMatchObject({ fired: 1, skipped: 0, missed: 0 });
    expect(await wakeCount(guest)).toBe(before + 1);
    expect(await fires()).toEqual([
      expect.objectContaining({ kind: "rsvp", outcome: "fired" }),
    ]);
    // Saying it again, or a run at the old notice time, fires nothing more.
    const again = await rsvp(guest, id, { going: true, notice_minutes: 15 });
    expect(again.body.changed).toBe(false);
    // Its wake already went: the answer says so, with no wake_at, rather
    // than "At wake_at your wake number rises".
    expect(again.body.rsvp.wake_at).toBeNull();
    expect(again.body.note).toBe(RSVP_NOTES.fired);
    expect(again.body.note).not.toMatch(/At wake_at/);
    expect(await workDue(at((await startsAt(id)) - MIN))).toMatchObject({
      fired: 0,
    });
    expect(await wakeCount(guest)).toBe(before + 1);
  });

  it("moved earlier than now, after one made in good time, fires at once, and only once", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 12);
    // Notice 5: due seven minutes from now, in good time.
    const first = await rsvp(guest, id, { going: true, notice_minutes: 5 });
    expect(first.status).toBe(200);
    expect(first.body.note).toBe(RSVP_NOTES.none);
    expect(await workDue(at(Date.now() + 1000))).toMatchObject({ fired: 0 });
    // Moved to 15: its notice time passed three minutes ago.
    const moved = await rsvp(guest, id, { going: true, notice_minutes: 15 });
    expect(moved.body.changed).toBe(true);
    expect(near(moved.body.rsvp.wake_at, Date.now())).toBe(true);
    const before = await wakeCount(guest);
    expect(await workDue(at(Date.now() + 1000))).toMatchObject({ fired: 1 });
    expect(await wakeCount(guest)).toBe(before + 1);
    // Moving it again, back and forth, and the old notice time coming,
    // fire nothing more: an item fires once per bot and gathering.
    for (const n of [5, 0, 10, 15]) {
      await db()`DELETE FROM rate_limits`;
      const r = await rsvp(guest, id, { going: true, notice_minutes: n });
      expect(r.status).toBe(200);
      expect(r.body.changed).toBe(true);
      expect(r.body.rsvp.wake_at).toBeNull();
      expect(r.body.note).toBe(RSVP_NOTES.fired);
    }
    expect(await workDue(at((await startsAt(id)) - 4 * MIN))).toMatchObject({
      fired: 0,
    });
    expect(await wakeCount(guest)).toBe(before + 1);
  });

  it("moved later fires at the new time, not at once", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 30);
    await rsvp(guest, id, { going: true, notice_minutes: 15 });
    await rsvp(guest, id, { going: true, notice_minutes: 5 });
    const start = await startsAt(id);
    expect(await workDue(at(start - 10 * MIN))).toMatchObject({ fired: 0 });
    expect(await workDue(at(start - 4 * MIN))).toMatchObject({ fired: 1 });
  });

  it("made once the gathering has started has no item, and says no wake is coming", async () => {
    const host = await register("host");
    const guest = await register("guest");
    expect(
      (
        await call(pushRoute, {
          key: guest.key,
          body: { url: "https://hooks.example.org/unprompted" },
        })
      ).status,
    ).toBe(201);
    const id = await gathering(host, -5);
    const said = await rsvp(guest, id, { going: true, notice_minutes: 10 });
    expect(said.status).toBe(200);
    expect(said.body.changed).toBe(true);
    expect(said.body.gathering.coming).toBe(1);
    expect(said.body.rsvp.wake_at).toBeNull();
    expect(said.body.note).toBe(RSVP_NOTES.started);
    expect(await dueFor(db(), await botId(guest))).toEqual([]);
    expect(await workDue(at(Date.now() + 1000))).toMatchObject({
      fired: 0,
      skipped: 0,
      missed: 0,
    });
    // A row dated after the start, written straight to the table, has none
    // either, whatever its notice.
    const later = await gathering(host, 10);
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes, created_at)
      SELECT ${later}, b.id, k.id, 10, now() + interval '11 minutes'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${guest.handle}`;
    expect(await workDue(at((await startsAt(later)) + 2 * MIN))).toMatchObject({
      fired: 0,
      skipped: 0,
      missed: 0,
    });
  });

  it("said again after the start, unchanged, keeps the wake made before it and says it's coming", async () => {
    const host = await register("host");
    const guest = await register("guest");
    expect(
      (
        await call(pushRoute, {
          key: guest.key,
          body: { url: "https://hooks.example.org/unprompted" },
        })
      ).status,
    ).toBe(201);
    // Starts in two seconds: the RSVP, made now with a notice of 5, comes
    // due at once, and no run works it before the start.
    const [made] = await db()<{ id: string }[]>`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, created_at)
      SELECT b.id, k.id, 'Jam', now() + interval '2 seconds',
             now() - interval '1 hour'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${host.handle}
      RETURNING id`;
    const id = Number(made?.id);
    const first = await rsvp(guest, id, { going: true, notice_minutes: 5 });
    expect(first.body.changed).toBe(true);
    expect(first.body.note).toBe(RSVP_NOTES.push);
    await new Promise((r) => setTimeout(r, 2500));
    const again = await rsvp(guest, id, { going: true, notice_minutes: 5 });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    // Not "no wake is coming": its item is still due, and fires now.
    expect(again.body.note).toBe(RSVP_NOTES.push);
    expect(again.body.note).not.toBe(RSVP_NOTES.started);
    expect(near(again.body.rsvp.wake_at, Date.now())).toBe(true);
    const before = await wakeCount(guest);
    expect(await workDue(at(Date.now() + 1000))).toMatchObject({ fired: 1 });
    expect(await wakeCount(guest)).toBe(before + 1);
    // Once it fired, saying it again says so.
    const after = await rsvp(guest, id, { going: true, notice_minutes: 5 });
    expect(after.body.note).toBe(RSVP_NOTES.fired);
    expect(after.body.rsvp.wake_at).toBeNull();
    // One made after the start, said again unchanged, still has none.
    const other = await register("other");
    const late = await rsvp(other, id, { going: true, notice_minutes: 10 });
    expect(late.body.note).toBe(RSVP_NOTES.started);
    const same = await rsvp(other, id, { going: true, notice_minutes: 10 });
    expect(same.body.changed).toBe(false);
    expect(same.body.note).toBe(RSVP_NOTES.started);
    expect(same.body.rsvp.wake_at).toBeNull();
  });

  it("holds to the site-wide cap and the frozen rule like any other item", async () => {
    await setAntiAbuse(db(), { event_fire_global: 1 }, "Test cap.");
    const host = await register("host");
    const a = await register("alice");
    const b = await register("bob");
    const c = await register("carol");
    const id = await gathering(host, 10);
    for (const bot of [a, b, c])
      expect(
        (await rsvp(bot, id, { going: true, notice_minutes: 15 })).status,
      ).toBe(200);
    await setFrozen(db(), c.handle, true, "Test.");
    const run = await workDue(at(Date.now() + 1000));
    expect(run).toMatchObject({ fired: 1, skipped: 2, capped: 1 });
    const rows = await fires();
    expect(rows.map((r) => r.reason).sort()).toEqual(
      ["cap", "frozen", null].sort(),
    );
    // Said again, each answer is true to its row: the fired one's wake
    // went, the capped one's time came without one.
    const firedBot = rows.find((r) => r.outcome === "fired")?.bot_id;
    for (const bot of [a, b]) {
      const r = await rsvp(bot, id, { going: true, notice_minutes: 15 });
      expect(r.body.changed).toBe(false);
      expect(r.body.rsvp.wake_at).toBeNull();
      expect(r.body.note).toBe(
        String(await botId(bot)) === String(firedBot)
          ? RSVP_NOTES.fired
          : RSVP_NOTES.passed,
      );
    }
  });

  it("over the connector, answers the same as the route", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const id = await gathering(host, 10);
    const r = await tool(guest.key, "rsvp", {
      gathering: id,
      going: true,
      notice_minutes: 15,
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(near(r.data.rsvp.wake_at, Date.now())).toBe(true);
    expect(await workDue(at(Date.now() + 1000))).toMatchObject({ fired: 1 });
  });
});
