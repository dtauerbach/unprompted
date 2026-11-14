import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as eventsRoute } from "@/app/v1/events/route";
import { POST as cancelRoute } from "@/app/v1/gatherings/[id]/cancel/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { POST as gatheringsRoute } from "@/app/v1/gatherings/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as createCodeRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as presenceRoute } from "@/app/v1/me/presence/route";
import { POST as pushRoute } from "@/app/v1/me/push/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import {
  setAntiAbuse,
  setFrozen,
  setGates,
  setGatheringHidden,
  setPrivateChannelHidden,
  setSilenced,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { dueFor, workDue } from "@/lib/due";
import { checkDue, forgetDueMinute } from "@/lib/due-check";
import { DUE_TAG } from "@/lib/due-kick";
import { LIMITS } from "@/lib/limits";
import { pickLeader, setOwnBots, startChannel } from "@/lib/private-channels";
import { READ_MAX_BYTES } from "@/lib/read-cap";
import {
  SESSION_DEFAULT_NOTICE,
  SESSION_END_NOTE,
  SESSION_MAX_DAYS,
  SESSION_NOTE,
  SESSION_TIMES_MAX,
} from "@/lib/sessions";
import { call, freshIp, register, resetDb } from "./helpers";
import { cacheCalls } from "./next-cache";

// Sessions in private channels (055_channel_sessions.sql, docs/CYCLE6.md,
// 6a's second PR): a group's leader, or either bot of a pair, sets when the
// channel meets; each occurrence wakes every member who hasn't declined,
// once, through the clock. Nothing a bot reads says who declined or how
// another bot would be woken. And a gathering's short end, decided once.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});

type Bot = { handle: string; key: string };
const MIN = 60_000;
const at = (ms: number) => new Date(ms);

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

async function idOf(b: Bot): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${b.handle}`;
  return Number(r?.id);
}

async function person(authId: string, ...bots: Bot[]): Promise<void> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  for (const b of bots)
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${b.handle}`;
}

async function group(authId: string, bots: Bot[], leader: Bot) {
  await person(authId, ...bots);
  const r = await startChannel(
    db(),
    authId,
    bots.map((b) => b.handle),
    leader.handle,
    null,
  );
  return r.channel;
}

// Three bots of one person, in one group that bob leads.
async function three() {
  const a = await bot("alice");
  const b = await bot("bob");
  const c = await bot("cat");
  const g = await group("google-p", [a, b, c], b);
  return { a, b, c, g };
}

// Two bots that can talk: contacts by a pairing code, so a pair's channel.
async function pairOf(x: string, y: string) {
  const a = await bot(x);
  const b = await bot(y);
  const made = await call(createCodeRoute, { key: a.key, body: {} });
  const r = await call(redeemRoute, {
    key: b.key,
    body: { code: made.body.code },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const [c] = await db()<{ channel_id: string }[]>`
    SELECT d.channel_id FROM direct_channels d
    WHERE (d.bot_low, d.bot_high) = (least(${await idOf(a)}::bigint, ${await idOf(b)}::bigint),
                                     greatest(${await idOf(a)}::bigint, ${await idOf(b)}::bigint))`;
  return { a, b, ch: `private:${c?.channel_id}` };
}

const event = (b: Bot, body: object) =>
  call(eventsRoute, { key: b.key, body, path: "/v1/events" });

const wake = async (b: Bot): Promise<number> =>
  (await call(wakeRoute, { key: b.key })).body.wake;

async function fires(kind = "session") {
  return db()<
    {
      event_id: string;
      occurrence: number;
      bot_id: string;
      outcome: string;
      reason: string | null;
    }[]
  >`SELECT event_id, occurrence, bot_id, outcome, reason FROM event_fires
    WHERE kind = ${kind} ORDER BY bot_id, occurrence`;
}

async function logged(action: string) {
  return db()<{ bot_id: string | null; subject: string; detail: unknown }[]>`
    SELECT bot_id, subject, detail FROM action_log
    WHERE action = ${action} ORDER BY id`;
}

async function used(bucket: string): Promise<number> {
  const [r] = await db()<{ count: number }[]>`
    SELECT count FROM rate_limits WHERE bucket = ${bucket}
    ORDER BY window_start DESC LIMIT 1`;
  return r?.count ?? 0;
}

// Moves every session row's times back, as if they had been set `minutes`
// earlier, and every membership so far with them (a member's item is never
// due before it joined): the tables are append-only, so their triggers are
// off for one transaction (test files run one at a time).
async function age(minutes: number) {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE channel_sessions DISABLE TRIGGER channel_sessions_append_only`;
    await tx`ALTER TABLE channel_members DISABLE TRIGGER channel_members_append_only`;
    await tx`
      UPDATE channel_sessions SET
        created_at = created_at - make_interval(mins => ${minutes}),
        chain_until = chain_until - make_interval(mins => ${minutes}),
        first_at = first_at - make_interval(mins => ${minutes})`;
    await tx`
      UPDATE channel_members SET
        created_at = created_at - make_interval(mins => ${minutes})`;
    await tx`ALTER TABLE channel_members ENABLE TRIGGER channel_members_append_only`;
    await tx`ALTER TABLE channel_sessions ENABLE TRIGGER channel_sessions_append_only`;
  });
}

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
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return { isError: result?.isError === true, data: data as any };
}

async function listTools(key: string): Promise<{ name: string }[]> {
  const req = new Request("http://unprompted.test/v1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-real-ip": freshIp(),
      host: "unprompted.test",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const res = await mcpRoute(req, undefined as never);
  return (await res.json()).result.tools;
}

describe("setting a session", () => {
  it("lets a group's leader set one, answering with the fixed note", async () => {
    const { b, g } = await three();
    const r = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 30,
      every_minutes: 60,
      times: 3,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.note).toBe(SESSION_NOTE);
    expect(SESSION_NOTE).toBe(
      "Members who can't be woken see it when they next visit. Keep sessions going until your person's deadline or say-so, even if the work looks done sooner. A posted final isn't frozen: when a member offers a fix that matters, put it in, post the final again and give your person its new id.",
    );
    expect(r.body.changed).toBe(true);
    expect(r.body.session).toMatchObject({
      channel: g,
      every_minutes: 60,
      times: 3,
    });
    const first = Date.parse(r.body.session.at);
    expect(Date.parse(r.body.session.last_at)).toBe(first + 120 * MIN);
    // Its own next visit, as every answer that touches a time gives.
    expect(r.body.next_visit.why).toBe("session");
    expect(r.body.next_visit.item.channel).toBe(g);
    const [line] = await logged("channel.session");
    expect(line?.subject).toMatch(/^session:\d+$/);
    expect(line?.detail).toMatchObject({ channel: g, every_minutes: 60 });
  });

  it("refuses another member 403 not_leader, and a bot outside 404 as a read gets", async () => {
    const { a, g } = await three();
    const other = await bot("dan");
    const notLeader = await event(a, {
      action: "session",
      channel: g,
      in_minutes: 30,
    });
    expect(notLeader.status).toBe(403);
    expect(notLeader.body.error.code).toBe("not_leader");
    const outside = await event(other, {
      action: "session",
      channel: g,
      in_minutes: 30,
    });
    const none = await event(other, {
      action: "session",
      channel: "private:999999",
      in_minutes: 30,
    });
    expect(outside.status).toBe(404);
    expect(outside.body).toEqual(none.body);
    expect(outside.body.error.code).toBe("no_such_channel");
    expect(await db()`SELECT 1 FROM channel_sessions`).toHaveLength(0);
  });

  it("follows the leader: a new leader may set it, the old one may not", async () => {
    const { a, b, g } = await three();
    await pickLeader(db(), "google-p", g, a.handle, null);
    expect(
      (await event(b, { action: "session", channel: g, in_minutes: 30 }))
        .status,
    ).toBe(403);
    expect(
      (await event(a, { action: "session", channel: g, in_minutes: 30 }))
        .status,
    ).toBe(200);
  });

  it("holds every bound: 5 minutes to 7 days ahead, 15 minutes apart, 12 times", async () => {
    const { b, g } = await three();
    const s = (body: object) =>
      event(b, { action: "session", channel: g, ...body });
    expect((await s({ in_minutes: 4 })).status).toBe(400);
    expect(
      (await s({ in_minutes: SESSION_MAX_DAYS * 24 * 60 + 1 })).status,
    ).toBe(400);
    expect(
      (
        await s({
          at: new Date(
            Date.now() + (SESSION_MAX_DAYS * 24 * 60 + 5) * MIN,
          ).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect((await s({ in_minutes: 30, every_minutes: 14 })).status).toBe(400);
    expect(
      (await s({ in_minutes: 30, every_minutes: 60, times: 13 })).status,
    ).toBe(400);
    expect((await s({ in_minutes: 30, times: 2 })).status).toBe(400);
    expect((await s({})).status).toBe(400);
    expect(
      (await s({ in_minutes: 30, at: new Date().toISOString() })).status,
    ).toBe(400);
    expect(await db()`SELECT 1 FROM channel_sessions`).toHaveLength(0);
    // Daily from 10 minutes ahead fits 7 times inside 7 days, cut from 12.
    const daily = await s({ in_minutes: 10, every_minutes: 1440, times: 12 });
    expect(daily.status, JSON.stringify(daily.body)).toBe(200);
    expect(daily.body.session.times).toBe(7);
    expect(Date.parse(daily.body.session.last_at)).toBeLessThanOrEqual(
      Date.now() + SESSION_MAX_DAYS * 24 * 60 * MIN,
    );
    // Every 15 minutes stops at 12.
    const quick = await s({ in_minutes: 10, every_minutes: 15 });
    expect(quick.body.session.times).toBe(SESSION_TIMES_MAX);
    // Exactly 5 minutes ahead is in bounds.
    expect((await s({ in_minutes: 5 })).status).toBe(200);
  });

  it("writes nothing and uses no allowance for the session already in force", async () => {
    const { b, g } = await three();
    const when = new Date(Date.now() + 30 * MIN).toISOString();
    const body = { action: "session", channel: g, at: when };
    expect((await event(b, body)).body.changed).toBe(true);
    const again = await event(b, body);
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(again.body.note).toBe(SESSION_NOTE);
    expect(await db()`SELECT 1 FROM channel_sessions`).toHaveLength(1);
  });

  it("counts against a public hourly limit, and not when refused", async () => {
    const { b, g } = await three();
    for (let i = 0; i < LIMITS.sessionPerHour.limit; i++) {
      const r = await event(b, {
        action: "session",
        channel: g,
        in_minutes: 10 + i,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const over = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 50,
    });
    expect(over.status).toBe(429);
    // Ending is never limited.
    const end = await event(b, { action: "end", channel: g });
    expect(end.status).toBe(200);
    expect(end.body.changed).toBe(true);
  });

  it("is refused to a silenced bot, and behind the set_session gate", async () => {
    const { b, g } = await three();
    await setSilenced(db(), b.handle, 2, "Test.");
    const r = await event(b, { action: "session", channel: g, in_minutes: 30 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("silenced");
    await setSilenced(db(), b.handle, null, "Test.");
    await setGates(
      db(),
      { set_session: [{ signal: "claimed", is: false }] },
      "Test.",
    );
    const gated = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 30,
    });
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe("not_yet");
  });

  it("is refused by the database to anyone but the leader, even past the app", async () => {
    const { a, g } = await three();
    const id = Number(g.slice(8));
    await expect(
      db()`
        INSERT INTO channel_sessions (channel_id, bot_id, key_id, first_at, occurrences)
        SELECT ${id}, b.id, k.id, now() + interval '30 minutes', 1
        FROM bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE b.handle = ${a.handle}`,
    ).rejects.toMatchObject({ code: "UPR01" });
    // And a time out of bounds, by the leader.
    await expect(
      db()`
        INSERT INTO channel_sessions (channel_id, bot_id, key_id, first_at, occurrences)
        SELECT ${id}, b.id, k.id, now() + interval '1 minute', 1
        FROM bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE b.handle = 'bob'`,
    ).rejects.toMatchObject({ code: "UPE01" });
  });
});

describe("a session's occurrences", () => {
  it("wake every member once, at the occurrence less its notice, and fire once", async () => {
    const { a, b, c, g } = await three();
    const r = await event(b, { action: "session", channel: g, in_minutes: 20 });
    const first = Date.parse(r.body.session.at);
    const before = [await wake(a), await wake(b), await wake(c)];
    const early = await workDue(
      at(first - SESSION_DEFAULT_NOTICE * MIN - 1000),
    );
    expect(early.fired).toBe(0);
    const run = await workDue(at(first - SESSION_DEFAULT_NOTICE * MIN + 1000));
    expect(run.fired).toBe(3);
    expect([await wake(a), await wake(b), await wake(c)]).toEqual(
      before.map((n) => n + 1),
    );
    expect((await workDue(at(first))).fired).toBe(0);
    expect(await fires()).toHaveLength(3);
    expect(await logged("event.fire")).toHaveLength(3);
  });

  it("takes each member's own notice", async () => {
    const { a, b, g } = await three();
    const r = await event(b, { action: "session", channel: g, in_minutes: 40 });
    const first = Date.parse(r.body.session.at);
    const n = await event(a, {
      action: "answer",
      channel: g,
      notice_minutes: 15,
    });
    expect(n.status, JSON.stringify(n.body)).toBe(200);
    expect(n.body.yours).toEqual({ coming: true, notice_minutes: 15 });
    const run = await workDue(at(first - 15 * MIN + 1000));
    expect(run.fired).toBe(1);
    const [f] = await fires();
    expect(Number(f?.bot_id)).toBe(await idOf(a));
  });

  it("wakes a member at once whose answer moves its notice past its time, as a late RSVP", async () => {
    const { a, b, c, g } = await three();
    const r = await event(b, { action: "session", channel: g, in_minutes: 20 });
    await age(12);
    const first = Date.parse(r.body.session.at) - 12 * MIN;
    const before = Date.now() - 1000;
    const n = await event(a, {
      action: "answer",
      channel: g,
      notice_minutes: 15,
    });
    expect(n.status, JSON.stringify(n.body)).toBe(200);
    // Due when it answered, not at first - 15 minutes, which had passed.
    const item = (await dueFor(db(), await idOf(a))).find(
      (d) => d.kind === "session",
    );
    expect(item?.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(item?.at.getTime()).toBeLessThan(first);
    const wa = await wake(a);
    const now = await workDue(at(Date.now() + 1000));
    expect(now.fired).toBe(1);
    expect(await wake(a)).toBe(wa + 1);
    const rest = await workDue(at(first - SESSION_DEFAULT_NOTICE * MIN + 1000));
    expect(rest.fired).toBe(2);
    const rows = await fires();
    expect(rows.map((x) => Number(x.bot_id)).sort()).toEqual(
      [await idOf(a), await idOf(b), await idOf(c)].sort(),
    );
    expect(await wake(a)).toBe(wa + 1);
  });

  it("leaves no item for a member who answers once the channel has met", async () => {
    const { a, b, c, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 20 });
    await age(25);
    const n = await event(a, {
      action: "answer",
      channel: g,
      notice_minutes: 10,
    });
    expect(n.status, JSON.stringify(n.body)).toBe(200);
    expect(
      (await dueFor(db(), await idOf(a))).filter((d) => d.kind === "session"),
    ).toEqual([]);
    // The others' items, due before it met, still fire late in its window.
    const run = await workDue(at(Date.now() + 1000));
    expect(run.fired).toBe(2);
    expect((await fires()).map((x) => Number(x.bot_id)).sort()).toEqual(
      [await idOf(b), await idOf(c)].sort(),
    );
    expect((await workDue(at(Date.now() + 2000))).fired).toBe(0);
  });

  it("leaves no item for a member put in once the channel has met", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const d = await bot("dan");
    const g = await group("google-p", [a, b], b);
    await event(b, { action: "session", channel: g, in_minutes: 20 });
    await age(25);
    await person("google-p", d);
    await setOwnBots(db(), "google-p", g, [d.handle], [], null);
    expect(
      (await dueFor(db(), await idOf(d))).filter((x) => x.kind === "session"),
    ).toEqual([]);
    // The others', due before it met, still fire late in its window.
    const run = await workDue(at(Date.now() + 1000));
    expect(run.fired).toBe(2);
    expect(run.missed).toBe(0);
    expect((await fires()).map((x) => Number(x.bot_id)).sort()).toEqual(
      [await idOf(a), await idOf(b)].sort(),
    );
    expect((await workDue(at(Date.now() + 2000))).fired).toBe(0);
  });

  it("wakes a member put in before the channel meets: at its notice, or at once if that had passed", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const d = await bot("dan");
    const e = await bot("eve");
    const g = await group("google-p", [a, b], b);
    await person("google-p", d, e);
    const r = await event(b, { action: "session", channel: g, in_minutes: 20 });
    const first = Date.parse(r.body.session.at);
    // Put in well before the notice time: due at the notice, like the rest.
    await setOwnBots(db(), "google-p", g, [d.handle], [], null);
    const early = (await dueFor(db(), await idOf(d))).find(
      (x) => x.kind === "session",
    );
    expect(
      Math.abs(
        (early?.at.getTime() ?? 0) - (first - SESSION_DEFAULT_NOTICE * MIN),
      ),
    ).toBeLessThan(1000);
    await age(17);
    const met = first - 17 * MIN;
    // Put in after the notice time had passed but before it meets: at once.
    const before = Date.now() - 1000;
    await setOwnBots(db(), "google-p", g, [e.handle], [], null);
    const late = (await dueFor(db(), await idOf(e))).find(
      (x) => x.kind === "session",
    );
    expect(late?.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(late?.at.getTime()).toBeLessThan(met);
    const we = await wake(e);
    const run = await workDue(at(Date.now() + 1000));
    expect(run.fired).toBe(4);
    expect((await fires()).map((x) => Number(x.bot_id)).sort()).toEqual(
      [await idOf(a), await idOf(b), await idOf(d), await idOf(e)].sort(),
    );
    // Read after it was put in: the session's wake is one more.
    expect(await wake(e)).toBe(we + 1);
  });

  it("fires only the latest occurrence after the clock was away, never the older ones", async () => {
    const { b, g } = await three();
    const r = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 10,
      every_minutes: 15,
      times: 4,
    });
    const first = Date.parse(r.body.session.at);
    const run = await workDue(at(first + 50 * MIN));
    expect(run.fired).toBe(3);
    expect(run.missed).toBe(0);
    const rows = await fires();
    expect(rows.map((x) => x.occurrence)).toEqual([3, 3, 3]);
    expect((await workDue(at(first + 55 * MIN))).fired).toBe(0);
  });

  it("each occurrence of a repeating session fires in turn", async () => {
    const { b, g } = await three();
    const r = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 10,
      every_minutes: 30,
      times: 2,
    });
    const first = Date.parse(r.body.session.at);
    expect((await workDue(at(first))).fired).toBe(3);
    expect((await workDue(at(first + 10 * MIN))).fired).toBe(0);
    expect((await workDue(at(first + 30 * MIN))).fired).toBe(3);
    expect((await fires()).map((x) => x.occurrence).sort()).toEqual([
      0, 0, 0, 1, 1, 1,
    ]);
  });

  // A live trial: once a group's leader called its work finished, nothing
  // brought the members back, and presence between them was refused. A
  // standing check-in brings them back; presence between members works too.
  it("brings a group back after it called its work finished: each check-in wakes every member, who read the channel", async () => {
    const { a, b, c, g } = await three();
    const id = g.slice("private:".length);
    const said = await call(sendRoute, {
      key: b.key,
      body: {
        channel: g,
        body: "Finished. Check the final text at the check-in.",
      },
    });
    expect(said.status, JSON.stringify(said.body)).toBe(201);
    // And a member that isn't the leader says when it'll be back with
    // presence, inboxes closed and nothing written one to one.
    const presence = await call(presenceRoute, {
      key: a.key,
      body: { with: "bob", state: "idle", next_check_in_minutes: 60 },
    });
    expect(presence.status, JSON.stringify(presence.body)).toBe(200);
    const r = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 30,
      every_minutes: 60,
      times: 3,
    });
    expect(r.status).toBe(200);
    const first = Date.parse(r.body.session.at);
    for (let n = 0; n < 3; n++) {
      const before = [await wake(a), await wake(b), await wake(c)];
      // Woken at each time less the 5 minutes' default notice.
      const due = first + n * 60 * MIN - SESSION_DEFAULT_NOTICE * MIN;
      expect((await workDue(at(due - MIN))).fired).toBe(0);
      // A run's upper bound is exclusive: the next second takes it.
      expect((await workDue(at(due + 1000))).fired).toBe(3);
      expect([await wake(a), await wake(b), await wake(c)]).toEqual(
        before.map((w) => w + 1),
      );
      for (const m of [a, c]) {
        const page = await call(readRoute, {
          key: m.key,
          path: `/v1/private-channels/${id}`,
          params: { id },
        });
        expect(page.status).toBe(200);
        expect(
          page.body.messages.map(
            (x: { untrusted_body: string }) => x.untrusted_body,
          ),
        ).toContain("Finished. Check the final text at the check-in.");
      }
    }
  });

  it("ends with a new session: the old one's times are gone", async () => {
    const { b, g } = await three();
    const old = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 10,
    });
    await event(b, { action: "session", channel: g, in_minutes: 60 });
    const run = await workDue(at(Date.parse(old.body.session.at)));
    expect(run.fired).toBe(0);
  });

  it("ends when the leader ends it; another member can't, and ending twice is safe", async () => {
    const { a, b, g } = await three();
    const r = await event(b, { action: "session", channel: g, in_minutes: 10 });
    const notLeader = await event(a, { action: "end", channel: g });
    expect(notLeader.status).toBe(403);
    expect(notLeader.body.error.code).toBe("not_leader");
    const end = await event(b, { action: "end", channel: g });
    expect(end.body).toMatchObject({
      session: null,
      changed: true,
      note: SESSION_END_NOTE,
    });
    const again = await event(b, { action: "end", channel: g });
    expect(again.body).toMatchObject({
      session: null,
      changed: false,
      note: SESSION_END_NOTE,
    });
    expect((await workDue(at(Date.parse(r.body.session.at)))).fired).toBe(0);
  });

  it("skips with setter while the setter is silenced, and those times stay gone", async () => {
    const { b, g } = await three();
    const r = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 10,
      every_minutes: 30,
      times: 2,
    });
    const first = Date.parse(r.body.session.at);
    await setSilenced(db(), b.handle, 1, "Test.");
    const run = await workDue(at(first));
    expect(run.fired).toBe(0);
    expect(run.skipped).toBe(3);
    expect((await fires()).every((f) => f.reason === "setter")).toBe(true);
    await setSilenced(db(), b.handle, null, "Test.");
    expect((await workDue(at(first + 5 * MIN))).fired).toBe(0);
    // The next occurrence fires as usual.
    expect((await workDue(at(first + 30 * MIN))).fired).toBe(3);
  });

  it("skips a frozen member, and never hangs on the key the setter used", async () => {
    const { a, b, g } = await three();
    let r = await event(b, { action: "session", channel: g, in_minutes: 10 });
    await setFrozen(db(), a.handle, true, "Test.");
    let run = await workDue(at(Date.parse(r.body.session.at)));
    expect(run.fired).toBe(2);
    expect((await fires()).filter((f) => f.reason === "frozen")).toHaveLength(
      1,
    );
    await setFrozen(db(), a.handle, false, "Test.");

    // The leader reconnects (a new key): the group's session still fires,
    // for every member, the leader too.
    r = await event(b, { action: "session", channel: g, in_minutes: 20 });
    const rotated = await call(rotateRoute, { key: b.key });
    expect(rotated.status).toBe(200);
    const before = await wake(a);
    run = await workDue(at(Date.parse(r.body.session.at)));
    expect(run.fired).toBe(3);
    expect(await wake(a)).toBe(before + 1);
    expect((await fires()).filter((f) => f.reason === "key")).toHaveLength(0);
    // And its new key can still end it, as the one who set it.
    const ended = await event(
      { handle: b.handle, key: rotated.body.api_key },
      { action: "end", channel: g },
    );
    expect(ended.status).toBe(200);
    expect(ended.body.changed).toBe(true);
  });

  it("refuses everything in a channel a moderator hid, and skips its times", async () => {
    const { b, g } = await three();
    const r = await event(b, { action: "session", channel: g, in_minutes: 10 });
    await setPrivateChannelHidden(db(), Number(g.slice(8)), true, "Test.");
    const refused = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 30,
    });
    expect(refused.status).toBe(404);
    const run = await workDue(at(Date.parse(r.body.session.at)));
    expect(run.fired).toBe(0);
    expect((await fires()).every((f) => f.reason === "hidden")).toBe(true);
  });

  it("counts its fires against the site-wide cap on group wakes", async () => {
    const { b, g } = await three();
    // Putting the three in the group used three of the hour's wakes: room
    // for one more.
    await setAntiAbuse(db(), { channel_wake_global: 4 }, "Test cap.");
    const r = await event(b, { action: "session", channel: g, in_minutes: 10 });
    const run = await workDue(at(Date.parse(r.body.session.at)));
    expect(run.fired).toBe(1);
    expect(run.capped).toBe(2);
    // The alert names the cap that skipped them.
    expect(await logged("alert.event_cap")).toEqual([
      expect.objectContaining({ subject: "channel_wake_global" }),
    ]);
  });

  it("leaves the cap on fires unused when the group cap refuses, and the other way round", async () => {
    const { a, b, g } = await three();
    // The group cap is used up (three wakes putting them in); a post's own
    // time in the same run still fires, and only it uses the fire cap.
    await setAntiAbuse(
      db(),
      { channel_wake_global: 3, event_fire_global: 100 },
      "Test cap.",
    );
    const r = await event(b, { action: "session", channel: g, in_minutes: 10 });
    const sessionAt = Date.parse(r.body.session.at);
    const posted = await call(postRoute, {
      key: a.key,
      body: {
        channel: "meta",
        title: "Back soon",
        body: "Back in a bit.",
        back_in_minutes: 5,
      },
    });
    expect(posted.status).toBe(201);
    const run = await workDue(at(sessionAt));
    expect(run.fired).toBe(1);
    expect(run.capped).toBe(3);
    expect(await used("event-fire:all")).toBe(1);
    expect(await used("channel-wake:all")).toBe(3);
    expect(await logged("alert.event_cap")).toEqual([
      expect.objectContaining({ subject: "channel_wake_global" }),
    ]);
  });

  it("leaves the group cap unused when the cap on fires refuses", async () => {
    const { b, g } = await three();
    await setAntiAbuse(
      db(),
      { channel_wake_global: 100, event_fire_global: 1 },
      "Test cap.",
    );
    const r = await event(b, { action: "session", channel: g, in_minutes: 10 });
    const run = await workDue(at(Date.parse(r.body.session.at)));
    expect(run.fired).toBe(1);
    expect(run.capped).toBe(2);
    expect(await used("event-fire:all")).toBe(1);
    // Three for putting them in, one for the one fire.
    expect(await used("channel-wake:all")).toBe(4);
    expect(await logged("alert.event_cap")).toEqual([
      expect.objectContaining({ subject: "event_fire_global" }),
    ]);
  });

  it("leaves the group's person's share of wakes alone", async () => {
    const { b, g } = await three();
    // Putting the three in used three of the person's share: a share with no
    // room left still lets every member's time fire, since that share also
    // bounds the person's group messages, and sessions have bounds of their own.
    await setAntiAbuse(
      db(),
      {
        group_wake_person: 3,
        channel_wake_global: 100,
        event_fire_global: 100,
      },
      "Test cap.",
    );
    const r = await event(b, { action: "session", channel: g, in_minutes: 10 });
    const run = await workDue(at(Date.parse(r.body.session.at)));
    expect(run.fired).toBe(3);
    expect(run.capped).toBe(0);
    const [share] = await db()<{ count: number }[]>`
      SELECT count FROM rate_limits WHERE bucket LIKE 'channel-wake:person:%'`;
    expect(share?.count).toBe(3);
    expect(await used("channel-wake:all")).toBe(6);
    expect(await used("event-fire:all")).toBe(3);
    expect(await logged("alert.event_cap")).toEqual([]);
  });

  it("counts a pair's fires against the cap on fires alone", async () => {
    const { a } = await pairOf("alice", "bob");
    const r = await event(a, {
      action: "session",
      with: "bob",
      in_minutes: 10,
    });
    const run = await workDue(at(Date.parse(r.body.session.at)));
    expect(run.fired).toBe(2);
    expect(await used("event-fire:all")).toBe(2);
    expect(await used("channel-wake:all")).toBe(0);
  });

  it("writes an occurrence past its window as missed, and never fires it", async () => {
    const { a, b, g } = await three();
    const r = await event(b, { action: "session", channel: g, in_minutes: 10 });
    const before = await wake(a);
    const run = await workDue(at(Date.parse(r.body.session.at) + 31 * MIN));
    expect(run.missed).toBe(3);
    expect(run.fired).toBe(0);
    expect((await fires()).map((f) => f.outcome)).toEqual([
      "missed",
      "missed",
      "missed",
    ]);
    expect(await wake(a)).toBe(before);
    const due = await dueFor(db(), await idOf(a));
    expect(due).toContainEqual(
      expect.objectContaining({ kind: "session", channel: g, state: "missed" }),
    );
  });

  it("doesn't wake a member again for a replacement at the same time, but does for a new time", async () => {
    const { a, b, g } = await three();
    const when = new Date(Date.now() + 20 * MIN).toISOString();
    const r = await event(b, { action: "session", channel: g, at: when });
    const t = Date.parse(r.body.session.at);
    let before = await wake(a);
    expect((await workDue(at(t))).fired).toBe(3);
    expect(await wake(a)).toBe(before + 1);
    // Replaced by one at the same time (now repeating): no second wake.
    const again = await event(b, {
      action: "session",
      channel: g,
      at: when,
      every_minutes: 60,
      times: 2,
    });
    expect(again.body.changed).toBe(true);
    before = await wake(a);
    expect((await workDue(at(t + MIN))).fired).toBe(0);
    expect(await wake(a)).toBe(before);
    // Its next occurrence, an hour on, is a new time: it wakes.
    expect((await workDue(at(t + 60 * MIN))).fired).toBe(3);
    expect(await wake(a)).toBe(before + 1);
    // So is a session at another time.
    const moved = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 30,
    });
    expect((await workDue(at(Date.parse(moved.body.session.at)))).fired).toBe(
      3,
    );
  });

  it("names when the channel meets in a member's due, beside when it's woken", async () => {
    const { a, b, g } = await three();
    await event(a, { action: "answer", channel: g, notice_minutes: 15 });
    const r = await event(b, { action: "session", channel: g, in_minutes: 40 });
    const starts = Date.parse(r.body.session.at);
    const coming = await dueFor(db(), await idOf(a));
    const item = coming.find((d) => d.kind === "session");
    expect(item?.starts_at?.getTime()).toBe(starts);
    expect(item?.at.getTime()).toBe(starts - 15 * MIN);
    await workDue(at(starts - 15 * MIN + 1000));
    const fired = (await dueFor(db(), await idOf(a))).find(
      (d) => d.kind === "session",
    );
    expect(fired).toMatchObject({ state: "fired" });
    expect(fired?.starts_at?.getTime()).toBe(starts);
    // Read over HTTP, in the digest.
    const d = await call(digestRoute, { key: a.key });
    expect(d.body.due[0].starts_at).toBe(new Date(starts).toISOString());
  });
});

describe("declining", () => {
  it("holds until the session ends, and carries over to one that replaces it", async () => {
    const { a, b, c, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 10 });
    const no = await event(a, { action: "answer", channel: g, coming: false });
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(no.body.yours.coming).toBe(false);
    // The leader sets it again: the decline carries over.
    const again = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 20,
    });
    const run = await workDue(at(Date.parse(again.body.session.at)));
    expect(run.fired).toBe(2);
    const woken = (await fires()).map((f) => Number(f.bot_id));
    expect(woken).not.toContain(await idOf(a));
    expect(woken).toContain(await idOf(c));
    // Ending and setting again doesn't undo it either, while the chain runs.
    await event(b, { action: "end", channel: g });
    const third = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 40,
    });
    const run3 = await workDue(at(Date.parse(third.body.session.at)));
    expect(run3.fired).toBe(2);
  });

  it("ends with the session: a new one after it has run wakes the decliner again", async () => {
    const { a, b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 10 });
    await event(a, { action: "answer", channel: g, coming: false });
    // As if the session had run its course an hour ago.
    await age(90);
    const fresh = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 10,
    });
    const run = await workDue(at(Date.parse(fresh.body.session.at)));
    expect(run.fired).toBe(3);
  });

  it("is seen by no one but the decliner: the leader's answers and the others' due are the same", async () => {
    const { a, b, c, g } = await three();
    const set = (m: number) =>
      event(b, { action: "session", channel: g, in_minutes: m });
    const strip = (body: Record<string, unknown>) => ({
      ...body,
      session: { ...(body.session as object), at: 0, last_at: 0 },
      // Each setting is a new session, so its item names a new event.
      next_visit: {
        ...(body.next_visit as { item?: object }),
        at: 0,
        item: { ...(body.next_visit as { item?: object }).item, event: 0 },
      },
    });
    await set(30);
    const plain = strip((await set(31)).body);
    await event(a, { action: "answer", channel: g, coming: false });
    const afterDecline = strip((await set(32)).body);
    expect(afterDecline).toEqual(plain);
    // Only the decliner's own due says declined.
    const mine = await dueFor(db(), await idOf(a));
    expect(mine.map((d) => d.state)).toContain("declined");
    for (const other of [b, c]) {
      const theirs = await dueFor(db(), await idOf(other));
      expect(theirs.map((d) => d.state)).not.toContain("declined");
      expect(JSON.stringify(theirs)).not.toContain(a.handle);
    }
    // The moderators' record keeps it.
    expect(await logged("channel.session_declined")).toHaveLength(1);
  });

  it("always works, for a silenced bot too, and uses no allowance; taking it back does", async () => {
    const { a, b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 10 });
    await setSilenced(db(), a.handle, 1, "Test.");
    const no = await event(a, { action: "answer", channel: g, coming: false });
    expect(no.status).toBe(200);
    const back = await event(a, { action: "answer", channel: g, coming: true });
    expect(back.status).toBe(403);
    await setSilenced(db(), a.handle, null, "Test.");
    const ok = await event(a, { action: "answer", channel: g, coming: true });
    expect(ok.body.yours.coming).toBe(true);
    const [used] = await db()<{ count: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS count FROM rate_limits
      WHERE bucket LIKE 'session-answer:%'`;
    expect(used?.count).toBe(1);
  });

  it("needs a session in force to decline, and a member to answer", async () => {
    const { a, g } = await three();
    const none = await event(a, {
      action: "answer",
      channel: g,
      coming: false,
    });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("no_session");
    const outsider = await bot("dan");
    const out = await event(outsider, {
      action: "answer",
      channel: g,
      notice_minutes: 10,
    });
    expect(out.status).toBe(404);
  });
});

describe("a pair's session", () => {
  it("is set by either bot, and wakes both", async () => {
    const { a, b, ch } = await pairOf("alice", "bob");
    const r = await event(a, {
      action: "session",
      with: "bob",
      in_minutes: 10,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.session.channel).toBe(ch);
    const r2 = await event(b, {
      action: "session",
      channel: ch,
      in_minutes: 20,
    });
    expect(r2.status).toBe(200);
    const run = await workDue(at(Date.parse(r2.body.session.at)));
    expect(run.fired).toBe(2);
  });

  it("needs two bots that can talk, with the refusals a message would get", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await call(inboxRoute, { key: a.key, body: { open: true } });
    await call(inboxRoute, { key: b.key, body: { open: true } });
    // Only alice has written: a request, not yet a conversation.
    await call(sendRoute, { key: a.key, body: { to: "bob", body: "Hi" } });
    const r = await event(a, {
      action: "session",
      with: "bob",
      in_minutes: 10,
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("no_conversation");
    // A blocked bot hears what a closed inbox would say.
    await call(sendRoute, { key: b.key, body: { to: "alice", body: "Hey" } });
    await call(blockRoute, {
      key: b.key,
      params: { handle: "alice" },
      path: "/v1/bots/alice/block",
    });
    const blocked = await event(a, {
      action: "session",
      with: "bob",
      in_minutes: 10,
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("not_accepting");
  });

  it("stops waking a bot that blocks the setter", async () => {
    const { a, b } = await pairOf("alice", "bob");
    const r = await event(a, {
      action: "session",
      with: "bob",
      in_minutes: 10,
    });
    await call(blockRoute, {
      key: b.key,
      params: { handle: "alice" },
      path: "/v1/bots/alice/block",
    });
    const run = await workDue(at(Date.parse(r.body.session.at)));
    expect(run.fired).toBe(1);
    expect((await fires()).filter((f) => f.reason === "blocked")).toHaveLength(
      1,
    );
  });

  it("stops waking the other bot once the setter blocks it after setting", async () => {
    const { a, b } = await pairOf("alice", "bob");
    const r = await event(a, {
      action: "session",
      with: "bob",
      in_minutes: 10,
    });
    expect(r.status).toBe(200);
    await call(blockRoute, {
      key: a.key,
      params: { handle: "bob" },
      path: "/v1/bots/bob/block",
    });
    const before = await wake(b);
    const run = await workDue(at(Date.parse(r.body.session.at)));
    expect(run.fired).toBe(1);
    expect(await wake(b)).toBe(before);
    const skipped = (await fires()).filter((f) => f.reason === "blocked");
    expect(skipped).toHaveLength(1);
    expect(Number(skipped[0]?.bot_id)).toBe(await idOf(b));
  });

  it("can't be probed for a decline: every answer to setting one is the same", async () => {
    const { a, b } = await pairOf("alice", "bob");
    const strip = (body: Record<string, unknown>) => ({
      ...body,
      session: { ...(body.session as object), at: 0, last_at: 0 },
      // Each setting is a new session, so its item names a new event.
      next_visit: {
        ...(body.next_visit as { item?: object }),
        at: 0,
        item: { ...(body.next_visit as { item?: object }).item, event: 0 },
      },
    });
    await event(a, { action: "session", with: "bob", in_minutes: 30 });
    const before = strip(
      (await event(a, { action: "session", with: "bob", in_minutes: 31 })).body,
    );
    await event(b, { action: "answer", with: "alice", coming: false });
    const after = strip(
      (await event(a, { action: "session", with: "bob", in_minutes: 32 })).body,
    );
    expect(after).toEqual(before);
  });
});

// A closed group takes nothing new (054_channel_plans.sql), sessions
// included (058_closed_sessions.sql): no session is set, no answer is
// taken, and none it had fires. Ending the one in force still works, since
// it only takes wakes away.
describe("a closed private channel", () => {
  const close = (b: Bot, g: string) =>
    call(closeRoute, { key: b.key, params: { id: g.slice(8) } });
  const count = async (
    table: "channel_sessions" | "channel_session_answers",
  ) => {
    const [r] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${db()(table)}`;
    return r?.n ?? 0;
  };

  it("takes no new session: refused as closed, as a message there is, writing and counting nothing", async () => {
    const { b, g } = await three();
    expect((await close(b, g)).status).toBe(200);
    const r = await event(b, { action: "session", channel: g, in_minutes: 30 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("channel_closed");
    const said = await call(sendRoute, {
      key: b.key,
      body: { channel: g, body: "Still here?" },
    });
    expect(r.body.error).toEqual(said.body.error);
    expect(await count("channel_sessions")).toBe(0);
    expect(await used(`session:${await idOf(b)}`)).toBe(0);
    expect(await logged("channel.session")).toHaveLength(0);
  });

  it("takes no answer to a session: a notice or a decline is refused as closed, writing nothing", async () => {
    const { a, b, g } = await three();
    expect(
      (await event(b, { action: "session", channel: g, in_minutes: 30 }))
        .status,
    ).toBe(200);
    expect((await close(b, g)).status).toBe(200);
    for (const body of [
      { notice_minutes: 15 },
      { coming: false },
      { coming: true, notice_minutes: 10 },
    ]) {
      const r = await event(a, { action: "answer", channel: g, ...body });
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(r.body.error.code).toBe("channel_closed");
    }
    expect(await count("channel_session_answers")).toBe(0);
  });

  it("still ends the session in force, which only takes wakes away", async () => {
    const { b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 30 });
    expect((await close(b, g)).status).toBe(200);
    const end = await event(b, { action: "end", channel: g });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect(end.body).toMatchObject({ session: null, changed: true });
  });

  it("fires none it had: every item is skipped as closed, due lists none coming, and nothing wakes", async () => {
    const { a, b, c, g } = await three();
    const r = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 10,
      every_minutes: 30,
      times: 3,
    });
    const first = Date.parse(r.body.session.at);
    // A declined member's items go too.
    await event(c, { action: "answer", channel: g, coming: false });
    expect(
      (await dueFor(db(), await idOf(a))).filter((d) => d.kind === "session"),
    ).not.toHaveLength(0);
    expect(
      (await dueFor(db(), await idOf(c))).filter(
        (d) => d.kind === "session" && d.state === "declined",
      ),
    ).not.toHaveLength(0);
    expect((await close(b, g)).status).toBe(200);
    for (const x of [a, b, c])
      expect(
        (await dueFor(db(), await idOf(x))).filter((d) => d.kind === "session"),
      ).toEqual([]);
    const before = [await wake(a), await wake(b), await wake(c)];
    for (let n = 0; n < 3; n++) {
      const run = await workDue(at(first + n * 30 * MIN));
      expect(run.fired, `occurrence ${n}`).toBe(0);
    }
    expect([await wake(a), await wake(b), await wake(c)]).toEqual(before);
    const rows = await fires();
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((f) => f.reason))).toEqual(new Set(["closed"]));
    // Skipped, not missed: a bot's own due never shows them.
    expect(
      (await dueFor(db(), await idOf(a))).filter((d) => d.kind === "session"),
    ).toEqual([]);
  });

  it("is backed by the database: a session or an answer written straight in is refused, an ending goes in", async () => {
    const { a, b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 30 });
    expect((await close(b, g)).status).toBe(200);
    const id = g.slice(8);
    const keyOf = async (x: Bot) => {
      const [k] = await db()<{ id: string }[]>`
        SELECT k.id FROM api_keys k JOIN bots o ON o.id = k.bot_id
        WHERE o.handle = ${x.handle} AND k.revoked_at IS NULL`;
      return k?.id ?? null;
    };
    const setRow = await db()`
      INSERT INTO channel_sessions
        (channel_id, bot_id, key_id, first_at, every_minutes, occurrences)
      VALUES (${id}, ${await idOf(b)}, ${await keyOf(b)},
              now() + interval '1 hour', NULL, 1)`.catch((e) => e);
    expect(setRow.code).toBe("UPR01");
    const answer = await db()`
      INSERT INTO channel_session_answers
        (channel_id, bot_id, key_id, declined_chain, notice_minutes)
      VALUES (${id}, ${await idOf(a)}, ${await keyOf(a)}, NULL, 15)`.catch(
      (e) => e,
    );
    expect(answer.code).toBe("UPR01");
    await db()`
      INSERT INTO channel_sessions (channel_id, bot_id, key_id)
      VALUES (${id}, ${await idOf(b)}, ${await keyOf(b)})`;
    expect(await count("channel_sessions")).toBe(2);
    expect(await count("channel_session_answers")).toBe(0);
  });

  it("refuses set_event on the connector the same way", async () => {
    const { b, g } = await three();
    expect((await close(b, g)).status).toBe(200);
    const s = await tool(b.key, "set_event", {
      action: "session",
      channel: g,
      in_minutes: 15,
    });
    expect(s.isError).toBe(true);
    expect(JSON.stringify(s.data)).toContain("channel_closed");
  });

  it("a session or an answer racing a close is refused as closed or skipped, never fired", async () => {
    for (let round = 0; round < 4; round++) {
      await resetDb();
      const { b, g } = await three();
      const [set, closed] = await Promise.all([
        event(b, { action: "session", channel: g, in_minutes: 10 }),
        close(b, g),
      ]);
      expect(closed.status).toBe(200);
      expect([200, 409], JSON.stringify(set.body)).toContain(set.status);
      if (set.status === 409)
        expect(set.body.error.code).toBe("channel_closed");
      if (set.status !== 200) continue;
      const run = await workDue(at(Date.parse(set.body.session.at)));
      expect(run.fired).toBe(0);
      expect(new Set((await fires()).map((f) => f.reason))).toEqual(
        new Set(["closed"]),
      );
    }
    for (let round = 0; round < 4; round++) {
      await resetDb();
      const { a, b, g } = await three();
      await event(b, { action: "session", channel: g, in_minutes: 30 });
      const [answer, closed] = await Promise.all([
        event(a, { action: "answer", channel: g, notice_minutes: 15 }),
        close(b, g),
      ]);
      expect(closed.status).toBe(200);
      expect([200, 409], JSON.stringify(answer.body)).toContain(answer.status);
      if (answer.status === 409)
        expect(answer.body.error.code).toBe("channel_closed");
    }
  }, 90_000);
});

describe("at the same time", () => {
  it("a clock run and group messages never deadlock", async () => {
    const { a, b, c, g } = await three();
    for (let round = 0; round < 8; round++) {
      // The leader sets it as the person hands the lead to the other.
      const [leader, next] = round % 2 === 0 ? [b, a] : [a, b];
      const r = await event(leader, {
        action: "session",
        channel: g,
        in_minutes: 10 + round,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // A time of Alice's own in the same run (an RSVP): her wake number,
      // lowest in bot_id order, is bumped first, before any session item.
      const [gath] = await db()<{ id: string }[]>`
        INSERT INTO gatherings (bot_id, key_id, title, starts_at, created_at)
        SELECT b.id, k.id, 'Jam', now() + make_interval(mins => ${15 + round}),
               now() - interval '1 hour'
        FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
        WHERE b.handle = ${c.handle}
        RETURNING id`;
      const going = await call(rsvpRoute, {
        key: a.key,
        body: { going: true, notice_minutes: 15 },
        params: { id: String(gath?.id) },
        path: `/v1/gatherings/${gath?.id}/rsvp`,
      });
      expect(going.status).toBe(200);
      const t = Date.parse(r.body.session.at);
      const sends = [a, b, c, a, c].map((x, i) =>
        call(sendRoute, {
          key: x.key,
          body: { channel: g, body: `Round ${round}, message ${i}.` },
        }),
      );
      const results = await Promise.all([
        workDue(at(t)),
        ...sends,
        pickLeader(db(), "google-p", g, next.handle, null),
      ]);
      const run = results[0] as Awaited<ReturnType<typeof workDue>>;
      expect(run.locked).toBe(false);
      for (const res of results.slice(1, 6) as { status: number }[])
        expect(res.status).toBe(201);
    }
  }, 60_000);

  it("a clock run and a person's group changes never deadlock", async () => {
    const { a, b, c, g } = await three();
    const d = await bot("dan");
    await person("google-p", d);
    for (let round = 0; round < 4; round++) {
      const r = await event(b, {
        action: "session",
        channel: g,
        in_minutes: 10 + round,
      });
      const t = Date.parse(r.body.session.at);
      const change =
        round % 2 === 0
          ? setOwnBots(db(), "google-p", g, [d.handle], [], null)
          : setOwnBots(db(), "google-p", g, [], [d.handle], null);
      const [run] = await Promise.all([
        workDue(at(t)),
        change,
        call(sendRoute, { key: a.key, body: { channel: g, body: "Hi." } }),
        call(sendRoute, { key: c.key, body: { channel: g, body: "Hey." } }),
      ]);
      expect(run.locked).toBe(false);
    }
  }, 60_000);

  it("two clock runs with a short end due write it once and wake each bot once", async () => {
    const host = await bot("host");
    const a = await bot("alice");
    const [g] = await db()<{ id: string; starts_at: Date }[]>`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, needs, created_at)
      SELECT b.id, k.id, 'Jam', now() + interval '40 minutes', 3, now() - interval '1 hour'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${host.handle}
      RETURNING id, starts_at`;
    const id = Number(g?.id);
    await call(rsvpRoute, {
      key: a.key,
      body: { going: true },
      params: { id: String(id) },
      path: `/v1/gatherings/${id}/rsvp`,
    });
    const t = at((g?.starts_at.getTime() ?? 0) - 14 * MIN);
    const before = await wake(a);
    const runs = await Promise.all([workDue(t), workDue(t), workDue(t)]);
    expect(runs.reduce((n, r) => n + r.shorts, 0)).toBe(1);
    // A run that got the lock may write the end before the other items;
    // one that waited for none finds nothing left.
    await workDue(t);
    expect(await fires("short")).toHaveLength(1);
    expect(await wake(a)).toBe(before + 1);
    expect(await logged("gathering.short")).toHaveLength(1);
  });

  it("a session set as the channel is hidden or its setter taken out ends up skipped, never half-written", async () => {
    for (const how of ["hide", "take_out"] as const) {
      await resetDb();
      const { b, g } = await three();
      const [set] = await Promise.all([
        event(b, { action: "session", channel: g, in_minutes: 10 }),
        how === "hide"
          ? setPrivateChannelHidden(db(), Number(g.slice(8)), true, "Test.")
          : setOwnBots(db(), "google-p", g, [], [b.handle], null),
      ]);
      expect([200, 404], JSON.stringify(set.body)).toContain(set.status);
      if (set.status !== 200) continue;
      const run = await workDue(at(Date.parse(set.body.session.at)));
      expect(run.fired, how).toBe(0);
      const reasons = new Set((await fires()).map((f) => f.reason));
      expect([...reasons]).toEqual([how === "hide" ? "hidden" : "setter"]);
    }
  }, 60_000);

  it("a decline racing a replacement holds for the replacement", async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb();
      const { a, b, g } = await three();
      await event(b, { action: "session", channel: g, in_minutes: 30 });
      const [no, replaced] = await Promise.all([
        event(a, { action: "answer", channel: g, coming: false }),
        event(b, { action: "session", channel: g, in_minutes: 10 }),
      ]);
      expect(no.status, JSON.stringify(no.body)).toBe(200);
      expect(replaced.status).toBe(200);
      const before = await wake(a);
      const run = await workDue(at(Date.parse(replaced.body.session.at)));
      expect(run.fired).toBe(2);
      expect(await wake(a)).toBe(before);
    }
  }, 60_000);
});

describe("the fixed sentence", () => {
  it("is the same in a pair, a group, and with or without members that can be woken", async () => {
    const { b, g } = await three();
    const inGroup = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 10,
    });
    const { a: p } = await pairOf("pat", "quinn");
    const inPair = await event(p, {
      action: "session",
      with: "quinn",
      in_minutes: 10,
    });
    // Some members get a push URL; the answer doesn't change.
    await call(pushRoute, {
      key: p.key,
      body: { url: "https://hooks.example.com/u" },
    }).catch(() => undefined);
    const withPush = await event(p, {
      action: "session",
      with: "quinn",
      in_minutes: 12,
    });
    for (const r of [inGroup, inPair, withPush]) {
      expect(r.body.note).toBe(SESSION_NOTE);
      expect(Object.keys(r.body).sort()).toEqual(
        ["changed", "next_visit", "note", "session"].sort(),
      );
      expect(JSON.stringify(r.body.session)).not.toMatch(/woken|push|wake_url/);
    }
  });
});

describe("what setting and ending a session say", () => {
  // Acceptance run mixed-8: a leader ended its channel's sessions at minute
  // 52 of 120 because the work looked done, and nobody worked the hour left.
  // Setting and ending each answer with fixed text that says the work
  // looking done is no reason to stop, the same in a group and a pair,
  // whoever is in it.
  it("answers a group's leader and a pair's bot with the same note, byte for byte, and ending with its own", async () => {
    const { b, g } = await three();
    const { a: p, ch } = await pairOf("pat", "quinn");
    const inGroup = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 30,
    });
    const inPair = await event(p, {
      action: "session",
      channel: ch,
      in_minutes: 45,
      every_minutes: 30,
    });
    const viaWith = await event(p, {
      action: "session",
      with: "quinn",
      in_minutes: 50,
    });
    for (const r of [inGroup, inPair, viaWith]) {
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.note).toBe(SESSION_NOTE);
    }
    expect(JSON.stringify(inPair.body.note)).toBe(
      JSON.stringify(inGroup.body.note),
    );
    expect(SESSION_NOTE).toContain(
      "Keep sessions going until your person's deadline or say-so, even if the work looks done sooner",
    );
    // Fixed: no number, handle or channel in it.
    expect(SESSION_NOTE).not.toMatch(/\d/);
    for (const h of [b.handle, p.handle, "quinn", "alice", "cat"])
      expect(SESSION_NOTE).not.toContain(h);

    const endGroup = await event(b, { action: "end", channel: g });
    const endPair = await event(p, { action: "end", with: "quinn" });
    // Ending with none in force answers the same.
    const endNone = await event(p, { action: "end", channel: ch });
    expect(endNone.body.changed).toBe(false);
    for (const r of [endGroup, endPair, endNone]) {
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.note).toBe(SESSION_END_NOTE);
      expect(Object.keys(r.body).sort()).toEqual(
        ["changed", "next_visit", "note", "session"].sort(),
      );
    }
    expect(SESSION_END_NOTE).toBe(
      "No session now. If you can still set one, your person's deadline hasn't passed and they haven't said to stop, set a new one, even if the work looks done: a posted final isn't frozen, so when a member offers a fix that matters, put it in, post it again and give your person its new id. No deadline? Ask them for one.",
    );
    expect(SESSION_END_NOTE).not.toMatch(/\d|\n/);
  });

  it("answers the same over the connector", async () => {
    const { b, g } = await three();
    const set = await tool(b.key, "set_event", {
      action: "session",
      channel: g,
      in_minutes: 20,
    });
    expect(set.isError, JSON.stringify(set.data)).toBe(false);
    expect(set.data.note).toBe(SESSION_NOTE);
    const end = await tool(b.key, "set_event", { action: "end", channel: g });
    expect(end.isError, JSON.stringify(end.data)).toBe(false);
    expect(end.data.note).toBe(SESSION_END_NOTE);
  });
});

describe("two groups", () => {
  it("a bot woken by one group's session reads nothing of the other's words in due", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const c = await bot("cat");
    const g1 = await group("google-p", [a, b], b);
    const g2 = await group("google-p", [a, c], c);
    await call(sendRoute, {
      key: c.key,
      body: { channel: g2, body: "SECRET-PLAN-FOR-G2" },
    });
    const r = await event(b, {
      action: "session",
      channel: g1,
      in_minutes: 10,
    });
    await workDue(at(Date.parse(r.body.session.at)));
    const due = await dueFor(db(), await idOf(a));
    expect(due.find((d) => d.state === "fired")?.channel).toBe(g1);
    const digest = await call(digestRoute, {
      key: a.key,
      path: "/v1/me/digest?since=0",
    });
    const text = JSON.stringify({
      due: digest.body.due,
      nv: digest.body.next_visit,
    });
    expect(text).toContain(g1);
    expect(text).not.toContain(g2);
    expect(text).not.toContain("SECRET-PLAN-FOR-G2");
  });

  it("a member taken out of a group no longer sees that group's items", async () => {
    const { a, b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 10 });
    expect((await dueFor(db(), await idOf(a))).length).toBe(1);
    const { setOwnBots } = await import("@/lib/private-channels");
    await setOwnBots(db(), "google-p", g, [], [a.handle], null);
    expect(await dueFor(db(), await idOf(a))).toEqual([]);
  });
});

describe("a gathering's short end", () => {
  async function gathering(host: Bot, inMinutes: number, needs: number) {
    const [g] = await db()<{ id: string }[]>`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, needs, created_at)
      SELECT b.id, k.id, 'Jam', now() + make_interval(mins => ${inMinutes}),
             ${needs}, now() - interval '1 hour'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${host.handle}
      RETURNING id, starts_at`;
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

  it("is decided once, 15 minutes before it starts, and wakes each bot coming once", async () => {
    const host = await bot("host");
    const a = await bot("alice");
    const b = await bot("bob");
    const id = await gathering(host, 40, 3);
    await rsvp(a, id, { going: true, notice_minutes: 0 });
    await rsvp(b, id, { going: true, notice_minutes: 15 });
    const t = (await startsAt(id)) - 15 * MIN;
    expect((await workDue(at(t - 1000))).shorts).toBe(0);
    const before = [await wake(a), await wake(b)];
    const run = await workDue(at(t + 1000));
    expect(run.shorts).toBe(1);
    expect(run.fired).toBe(2);
    expect([await wake(a), await wake(b)]).toEqual(before.map((n) => n + 1));
    const [end] = await db()<{ kind: string; key_id: string | null }[]>`
      SELECT kind, key_id FROM gathering_ends WHERE gathering_id = ${id}`;
    expect(end).toEqual({ kind: "short", key_id: null });
    expect(await logged("gathering.short")).toHaveLength(1);
    // No RSVP item fires after: not bob's notice now, not alice's at the start.
    expect(await fires("rsvp")).toHaveLength(0);
    const later = await workDue(at(await startsAt(id)));
    expect(later.fired).toBe(0);
    expect(later.shorts).toBe(0);
    expect(await fires("short")).toHaveLength(2);
    // RSVPs to it are refused.
    const c = await bot("cat");
    expect((await rsvp(c, id, { going: true })).status).toBe(409);
  });

  it("isn't written when enough are coming: their RSVPs fire as usual", async () => {
    const host = await bot("host");
    const a = await bot("alice");
    const id = await gathering(host, 40, 1);
    await rsvp(a, id, { going: true, notice_minutes: 5 });
    const run = await workDue(at((await startsAt(id)) - 5 * MIN + 1000));
    expect(run.shorts).toBe(0);
    expect(run.fired).toBe(1);
    expect(await db()`SELECT 1 FROM gathering_ends`).toHaveLength(0);
  });

  it("is decided on who was coming then: a withdrawal after it changes nothing", async () => {
    const host = await bot("host");
    const a = await bot("alice");
    const id = await gathering(host, 40, 1);
    await rsvp(a, id, { going: true, notice_minutes: 0 });
    const starts = await startsAt(id);
    // alice withdraws 10 minutes before the start, after the decision time.
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, created_at)
      VALUES (${id}, ${await idOf(a)}, ${at(starts - 10 * MIN)})`;
    const run = await workDue(at(starts - 5 * MIN));
    expect(run.shorts).toBe(0);
  });

  it("is written with nobody coming, and is in the soonest time the clock reads", async () => {
    const host = await bot("host");
    const id = await gathering(host, 40, 2);
    const { soonestDue } = await import("@/lib/due");
    const soonest = await soonestDue(db());
    expect(soonest.next?.getTime()).toBe((await startsAt(id)) - 15 * MIN);
    const run = await workDue(at((await startsAt(id)) - 14 * MIN));
    expect(run.shorts).toBe(1);
    expect(run.fired).toBe(0);
    expect((await soonestDue(db())).next).toBeNull();
  });

  it("clears the clock's cached time when announced with needs, so its decision isn't missed", async () => {
    const host = await bot("host");
    await person("google-h", host);
    const now = Date.now();
    // Nothing on the list: the soonest time is cached as none.
    expect(await checkDue(now)).toBe("not_due");
    const dueClears = () =>
      cacheCalls.revalidateTag.filter((c) => c.tag === DUE_TAG).length;
    const n = dueClears();
    const made = await event(host, {
      action: "announce",
      title: "Jam",
      starts_at: new Date(now + 20 * MIN).toISOString(),
      needs: 2,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(dueClears()).toBeGreaterThan(n);
    // Five minutes on, the decision is due: the clock reads it and ends it.
    expect(await checkDue(now + 6 * MIN)).toBe("worked");
    const [end] = await db()<{ kind: string }[]>`
      SELECT kind FROM gathering_ends WHERE gathering_id = ${made.body.gathering.id}`;
    expect(end).toEqual({ kind: "short" });
    // Without needs there's nothing to decide, but its start is one the
    // clock reads near (052), so the cache is cleared too.
    const m = dueClears();
    const plain = await event(host, {
      action: "announce",
      title: "Open jam",
      starts_at: new Date(now + 60 * MIN).toISOString(),
    });
    expect(plain.status).toBe(201);
    expect(dueClears()).toBeGreaterThan(m);
  });

  it("isn't written for a gathering a moderator hid", async () => {
    const host = await bot("host");
    const id = await gathering(host, 40, 2);
    await setGatheringHidden(db(), id, true, "Test.");
    const run = await workDue(at((await startsAt(id)) - 14 * MIN));
    expect(run.shorts).toBe(0);
    expect(
      await db()`SELECT 1 FROM gathering_ends WHERE gathering_id = ${id}`,
    ).toHaveLength(0);
  });

  it("isn't written once the gathering is over, or after a cancel", async () => {
    const host = await bot("host");
    const id = await gathering(host, 40, 2);
    const late = await workDue(at((await startsAt(id)) + 31 * MIN));
    expect(late.shorts).toBe(0);
    // Sooner than the first one's decision, so only this one is in reach.
    const id2 = await gathering(host, 20, 2);
    await call(cancelRoute, {
      key: host.key,
      params: { id: String(id2) },
      path: `/v1/gatherings/${id2}/cancel`,
    });
    const run = await workDue(at((await startsAt(id2)) - 14 * MIN));
    expect(run.shorts).toBe(0);
    expect(
      await db()`SELECT kind FROM gathering_ends WHERE gathering_id = ${id2}`,
    ).toEqual([{ kind: "cancelled" }]);
  });
});

describe("set_event on the connector", () => {
  it("says, where a leader sets or ends a session, to keep sessions going even if the work looks done", async () => {
    const a = await bot("alice");
    const tools = (await listTools(a.key)) as {
      name: string;
      description?: string;
    }[];
    const desc = tools.find((t) => t.name === "set_event")?.description ?? "";
    expect(desc).toContain(
      "Keep sessions going until your person's deadline or say-so, even if the work looks done sooner: a posted final still takes fixes.",
    );
    // Right after end, the action a leader takes to stop.
    expect(desc).toContain("end: stops it. Keep sessions going");
  });

  it("replaces announce_gathering and cancel_gathering, whose routes still answer, and keeps set_presence", async () => {
    const a = await bot("alice");
    const names = (await listTools(a.key)).map((t) => t.name);
    expect(names).toContain("set_event");
    for (const gone of ["announce_gathering", "cancel_gathering"])
      expect(names).not.toContain(gone);
    // A session is the leader's alone, so a member says when it'll be back
    // with presence: it stays until a session can carry that.
    expect(names).toContain("set_presence");
    // The routes keep answering.
    const p = await call(presenceRoute, {
      key: a.key,
      body: { with: "nobody-here", state: "idle" },
    });
    expect(p.status).toBe(404);
    const g = await call(gatheringsRoute, {
      key: a.key,
      body: {
        title: "Jam",
        starts_at: new Date(Date.now() + 60 * MIN).toISOString(),
      },
    });
    expect([201, 403]).toContain(g.status);
  });

  it("announces and cancels a gathering, and sets a session", async () => {
    const host = await bot("host");
    await person("google-h", host);
    const made = await tool(host.key, "set_event", {
      action: "announce",
      title: "Jam session",
      starts_at: new Date(Date.now() + 60 * MIN).toISOString(),
      needs: 2,
    });
    expect(made.isError, JSON.stringify(made.data)).toBe(false);
    const id = made.data.gathering.id;
    const cancelled = await tool(host.key, "set_event", {
      action: "cancel",
      gathering: id,
    });
    expect(cancelled.data.gathering.state).toBe("cancelled");
    expect(cancelled.data.changed).toBe(true);

    const { b, g } = await three();
    const s = await tool(b.key, "set_event", {
      action: "session",
      channel: g,
      in_minutes: 15,
    });
    expect(s.isError, JSON.stringify(s.data)).toBe(false);
    expect(s.data.note).toBe(SESSION_NOTE);
  });

  it("refuses fields that don't go with the action", async () => {
    const { b, g } = await three();
    const r = await event(b, {
      action: "end",
      channel: g,
      in_minutes: 15,
    });
    expect(r.status).toBe(400);
    const r2 = await event(b, { action: "announce", channel: g });
    expect(r2.status).toBe(400);
  });
});

describe("what a woken bot reads", () => {
  it("keeps the digest inside the read cap with due full of session items", async () => {
    const owner = await bot("owner");
    const peers: Bot[] = [];
    for (let i = 0; i < 6; i++) peers.push(await bot(`peer${i}`));
    for (let i = 0; i < 6; i++) {
      const peer = peers[i] as Bot;
      const g = await group("google-x", [owner, peer], peer);
      await event(peer, {
        action: "session",
        channel: g,
        in_minutes: 10 + i,
        every_minutes: 15,
      });
    }
    const due = await dueFor(db(), await idOf(owner));
    expect(due.length).toBeGreaterThan(4);
    const d = await call(digestRoute, {
      key: owner.key,
      path: "/v1/me/digest?since=0",
    });
    expect(Buffer.byteLength(JSON.stringify(d.body))).toBeLessThanOrEqual(
      READ_MAX_BYTES,
    );
  });
});
