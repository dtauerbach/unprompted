import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as eventsRoute } from "@/app/v1/events/route";
import { POST as cancelRoute } from "@/app/v1/gatherings/[id]/cancel/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { GET as listRoute } from "@/app/v1/gatherings/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { setGates } from "@/lib/admin";
import { db } from "@/lib/db";
import { soonestDue, workDue } from "@/lib/due";
import { lookupBot } from "@/lib/lookup";
import { NEXT_VISIT_NOTES, nextVisit } from "@/lib/next-visit";
import {
  HANDOFF_MINUTES,
  TURN_MIN_MINUTES,
  TURN_NOTES,
  TURN_NOTICE,
} from "@/lib/turns";
import {
  TURN_MINUTES_DEFAULT,
  TURN_MINUTES_MAX,
  TURN_MINUTES_MIN,
  TURN_SEQ_MAX,
} from "@/lib/validate";
import { call, freshIp, linkBot, register, resetDb } from "./helpers";

// A gathering's turns (EV9a, 106_gathering_turns.sql, src/lib/turns.ts):
// once it has started, its host starts turns and the site hands each bot
// coming the floor in seat order, once each. No read names who holds one.

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

let owners = 0;
async function trusted(handle: string): Promise<Bot> {
  const bot = await register(handle);
  owners += 1;
  await linkBot(bot.key, `google-t${owners}`);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${bot.handle}`;
  return bot;
}

async function keyOf(handle: string): Promise<string> {
  const [k] = await db()<{ id: string }[]>`
    SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
    WHERE b.handle = ${handle} AND k.revoked_at IS NULL`;
  if (!k) throw new Error(`no key for ${handle}`);
  return k.id;
}

async function idOf(b: Bot): Promise<string> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${b.handle}`;
  return r?.id ?? "";
}

// A gathering announced a day ago, started startedMinutesAgo, lasting lasts.
async function running(
  host: Bot,
  startedMinutesAgo = 5,
  lasts = 120,
  capacity: number | null = null,
): Promise<number> {
  const key = await keyOf(host.handle);
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, lasts_minutes, capacity, created_at)
    SELECT b.id, ${key}, 'Hackathon', now() - make_interval(mins => ${startedMinutesAgo}),
           ${lasts}, ${capacity}, now() - interval '1 day'
    FROM bots b WHERE b.handle = ${host.handle}
    RETURNING id`;
  return Number(g?.id);
}

const rsvp = (b: Bot, id: number, body: unknown = { going: true }) =>
  call(rsvpRoute, {
    key: b.key,
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/rsvp`,
  });

const turn = (b: Bot, body: Record<string, unknown>) =>
  call(eventsRoute, {
    key: b.key,
    body: { action: "turn", ...body },
    path: "/v1/events",
  });

const list = (b: Bot) =>
  call(listRoute, { key: b.key, path: "/v1/gatherings" });
const digest = (b: Bot) =>
  call(digestRoute, { key: b.key, path: "/v1/me/digest" });

async function wakeOf(b: Bot): Promise<number> {
  const [r] = await db()<{ n: string }[]>`
    SELECT coalesce((SELECT w.count FROM wake_counters w WHERE w.bot_id = b.id), 0) AS n
    FROM bots b WHERE b.handle = ${b.handle}`;
  return Number(r?.n ?? 0);
}

// Moves the newest turn of a gathering, and its end, `minutes` into the
// past, as if it had opened (and ended) that long ago.
async function age(gid: number, minutes: number): Promise<void> {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE gathering_turns DISABLE TRIGGER gathering_turns_append_only`;
    await tx`ALTER TABLE gathering_turn_ends DISABLE TRIGGER gathering_turn_ends_append_only`;
    const [t] = await tx<{ id: string }[]>`
      SELECT id FROM gathering_turns WHERE gathering_id = ${gid}
      ORDER BY seq DESC LIMIT 1`;
    await tx`
      UPDATE gathering_turns
      SET created_at = created_at - make_interval(mins => ${minutes}),
          deadline = deadline - make_interval(mins => ${minutes})
      WHERE id = ${t?.id ?? 0}`;
    await tx`
      UPDATE gathering_turn_ends SET at = at - make_interval(mins => ${minutes})
      WHERE turn_id = ${t?.id ?? 0}`;
    await tx`ALTER TABLE gathering_turns ENABLE TRIGGER gathering_turns_append_only`;
    await tx`ALTER TABLE gathering_turn_ends ENABLE TRIGGER gathering_turn_ends_append_only`;
  });
}

async function holderOf(gid: number, seq: number): Promise<string | undefined> {
  const [r] = await db()<{ handle: string }[]>`
    SELECT b.handle FROM gathering_turns t JOIN bots b ON b.id = t.holder_bot_id
    WHERE t.gathering_id = ${gid} AND t.seq = ${seq}`;
  return r?.handle;
}

async function endOf(gid: number, seq: number) {
  const [r] = await db()<{ outcome: string; reason: string | null }[]>`
    SELECT e.outcome, e.reason FROM gathering_turn_ends e
    JOIN gathering_turns t ON t.id = e.turn_id
    WHERE t.gathering_id = ${gid} AND t.seq = ${seq}`;
  return r;
}

async function closeOf(gid: number): Promise<string | undefined> {
  const [r] = await db()<{ why: string }[]>`
    SELECT why FROM gathering_turn_closes WHERE gathering_id = ${gid}`;
  return r?.why;
}

// A host and three bots coming, seated in order (a capacity gives places).
async function room(n = 3) {
  const host = await trusted("host");
  const gid = await running(host, 5, 120, 10);
  const bots: Bot[] = [];
  for (let i = 0; i < n; i += 1) {
    const b = await trusted(`guest${i}`);
    expect((await rsvp(b, gid)).status).toBe(200);
    bots.push(b);
  }
  return { host, gid, bots };
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

describe("a gathering's turns", () => {
  it("says the same numbers in code and in the database", async () => {
    const [c] = await db()<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'gathering_turns'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%seq%'`;
    expect(c?.def).toContain(`${TURN_SEQ_MAX}`);
    const [r] = await db()<{ handoff: number; min: number }[]>`
      SELECT extract(epoch FROM gathering_turn_handoff())::int / 60 AS handoff,
             extract(epoch FROM gathering_turn_min())::int / 60 AS min`;
    expect(r).toEqual({ handoff: HANDOFF_MINUTES, min: TURN_MIN_MINUTES });
    expect([TURN_MINUTES_MIN, TURN_MINUTES_DEFAULT, TURN_MINUTES_MAX]).toEqual([
      2, 5, 30,
    ]);
  });

  it("starts in seat order, wakes the holder, and shows each bot only its own part", async () => {
    const { host, gid, bots } = await room();
    const [a, b, c] = bots as [Bot, Bot, Bot];
    const before = await wakeOf(a);
    const res = await turn(host, {
      gathering: gid,
      op: "start",
      task: "Pitch your project",
      minutes: 4,
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.note).toBe(TURN_NOTES.host);
    expect(res.body.notice).toBe(TURN_NOTICE);
    expect(res.body.turns).toMatchObject({
      phase: "open",
      seq: 1,
      you: "host",
      untrusted_task: "Pitch your project",
      waiting: 2,
    });
    expect(await holderOf(gid, 1)).toBe(a.handle);
    // The host never learns who holds it.
    for (const g of bots)
      expect(JSON.stringify(res.body)).not.toContain(g.handle);

    const mine = (await list(a)).body.gatherings.find(
      (g: { id: number }) => g.id === gid,
    );
    expect(mine.turns).toMatchObject({
      phase: "open",
      seq: 1,
      you: "holder",
      untrusted_task: "Pitch your project",
    });
    expect(
      new Date(mine.turns.deadline).getTime() - Date.now(),
    ).toBeGreaterThan(3 * 60_000);
    const theirs = (await list(b)).body.gatherings.find(
      (g: { id: number }) => g.id === gid,
    );
    expect(theirs.turns.you).toBe("waiting");
    expect(theirs.turns).not.toHaveProperty("untrusted_task");
    // What's new leaves turns out; its due items say when one is yours.
    const news = (await digest(a)).body.gatherings.find(
      (g: { id: number }) => g.id === gid,
    );
    expect(news).not.toHaveProperty("turns");
    expect(JSON.stringify((await list(c)).body)).not.toContain(a.handle);

    // The clock wakes the holder.
    const run = await workDue();
    expect(run.fired).toBeGreaterThanOrEqual(1);
    expect((await wakeOf(a)) - before).toBe(1);
    const [log] = await db()<{ detail: { minutes: number } }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.turns.start'`;
    expect(log?.detail).toEqual({ minutes: 4 });
  });

  it("takes turns only once the gathering has started, and only from its host", async () => {
    const host = await trusted("host");
    const key = await keyOf(host.handle);
    const [g] = await db()<{ id: string }[]>`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, created_at)
      SELECT b.id, ${key}, 'Later', now() + interval '1 hour', now() - interval '1 day'
      FROM bots b WHERE b.handle = ${host.handle} RETURNING id`;
    const later = Number(g?.id);
    const a = await trusted("alpha");
    await rsvp(a, later);
    expect(
      (await turn(host, { gathering: later, op: "start" })).body.error.code,
    ).toBe("not_started");
    const gid = await running(host);
    await rsvp(a, gid);
    const other = await turn(a, { gathering: gid, op: "start" });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("not_your_gathering");
    const none = await turn(host, { gathering: 999999, op: "start" });
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe("no_such_gathering");
    const empty = await running(host);
    expect(
      (await turn(host, { gathering: empty, op: "start" })).body.error.code,
    ).toBe("nobody_waiting");
    // Starting twice is refused, and writes nothing.
    expect((await turn(host, { gathering: gid, op: "start" })).status).toBe(
      200,
    );
    expect(
      (await turn(host, { gathering: gid, op: "start" })).body.error.code,
    ).toBe("turns_started");
    const turns =
      await db()`SELECT 1 FROM gathering_turns WHERE gathering_id = ${gid}`;
    expect(turns.length).toBe(1);
  });

  it("refuses a turn when too little of the gathering is left", async () => {
    const host = await trusted("host");
    const gid = await running(host, 29, 30);
    const a = await trusted("alpha");
    await rsvp(a, gid);
    const res = await turn(host, { gathering: gid, op: "start" });
    expect(res.status).toBe(409);
    expect(["no_time", "gathering_closed"]).toContain(res.body.error.code);
  });

  it("lets the holder say done once, wakes the host, and lets the host call the next at once", async () => {
    const { host, gid, bots } = await room();
    const [a, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start", task: "Demo" });
    await workDue();
    const hostBefore = await wakeOf(host);
    const done = await turn(a, { gathering: gid, op: "done", seq: 1 });
    expect(done.status).toBe(200);
    expect(done.body.changed).toBe(true);
    expect(done.body.note).toBe(TURN_NOTES.holder);
    expect(done.body.turns.you).toBe("had_turn");
    // Again: nothing more is written.
    const again = await turn(a, { gathering: gid, op: "done", seq: 1 });
    expect(again.body.changed).toBe(false);
    const flip = await turn(a, { gathering: gid, op: "declined", seq: 1 });
    expect(flip.status).toBe(409);
    expect(flip.body.error.code).toBe("turn_over");
    expect((await endOf(gid, 1))?.outcome).toBe("done");

    await workDue();
    expect((await wakeOf(host)) - hostBefore).toBe(1);
    const seen = (await list(host)).body.gatherings.find(
      (g: { id: number }) => g.id === gid,
    );
    expect(seen.turns).toMatchObject({
      phase: "handoff",
      outcome: "done",
      you: "host",
    });
    expect(seen.turns.next_at).toBeDefined();

    // The clock waits out the host's window.
    await workDue();
    expect(await holderOf(gid, 2)).toBeUndefined();
    const stale = await turn(host, { gathering: gid, op: "next", seq: 2 });
    expect(stale.body.error.code).toBe("stale_turn");
    const next = await turn(host, {
      gathering: gid,
      op: "next",
      seq: 1,
      task: "Q and A",
    });
    expect(next.status).toBe(200);
    expect(await holderOf(gid, 2)).toBe(b.handle);
    const bs = (await list(b)).body.gatherings.find(
      (g: { id: number }) => g.id === gid,
    );
    expect(bs.turns).toMatchObject({
      seq: 2,
      you: "holder",
      untrusted_task: "Q and A",
    });
  });

  it("keeps a declined turn's reason off what the host reads", async () => {
    const { host, gid, bots } = await room(2);
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    const res = await turn(a, {
      gathering: gid,
      op: "declined",
      seq: 1,
      reason: "missing_input",
    });
    expect(res.status).toBe(200);
    expect(await endOf(gid, 1)).toEqual({
      outcome: "declined",
      reason: "missing_input",
    });
    const seen = (await list(host)).body;
    expect(JSON.stringify(seen)).not.toContain("missing_input");
    expect(
      seen.gatherings.find((g: { id: number }) => g.id === gid).turns.outcome,
    ).toBe("declined");
    // Nor the moderators' log: the holder's own row keeps it alone.
    const [line] = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.turn.declined'`;
    expect(line?.detail).toEqual({ seq: 1 });
  });

  it("refuses a holder op for a turn that isn't the caller's", async () => {
    const { host, gid, bots } = await room(2);
    const [, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start" });
    const res = await turn(b, { gathering: gid, op: "done", seq: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("no_such_turn");
    const outsider = await trusted("outsider");
    expect(
      (await turn(outsider, { gathering: gid, op: "done", seq: 1 })).status,
    ).toBe(404);
  });

  it("opens the next turn by itself once the host's window passes", async () => {
    const { host, gid, bots } = await room();
    const [a, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start", task: "Demo" });
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    await age(gid, HANDOFF_MINUTES + 1);
    const run = await workDue();
    expect(run.turns).toBe(1);
    expect(await holderOf(gid, 2)).toBe(b.handle);
    const [t] = await db()<{ opened_by: string; task: string }[]>`
      SELECT opened_by, task FROM gathering_turns WHERE gathering_id = ${gid} AND seq = 2`;
    expect(t).toEqual({ opened_by: "site", task: "Demo" });
    const logs =
      await db()`SELECT 1 FROM action_log WHERE action = 'gathering.turns.open'`;
    expect(logs.length).toBe(1);
  });

  it("ends a turn whose time ran out and opens the next at once", async () => {
    const { host, gid, bots } = await room();
    const [a, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start", minutes: 2 });
    await age(gid, 3);
    await workDue();
    expect((await endOf(gid, 1))?.outcome).toBe("expired");
    expect(await holderOf(gid, 2)).toBe(b.handle);
    const late = await turn(a, { gathering: gid, op: "done", seq: 1 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("turn_over");
  });

  it("ends a turn whose holder stopped coming, and refuses its done", async () => {
    const { host, gid, bots } = await room();
    const [a, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start" });
    expect((await rsvp(a, gid, { going: false })).status).toBe(200);
    const late = await turn(a, { gathering: gid, op: "done", seq: 1 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("turn_over");
    await workDue();
    expect((await endOf(gid, 1))?.outcome).toBe("lost");
    expect(await holderOf(gid, 2)).toBe(b.handle);
  });

  it("closes the turns once everyone has had one", async () => {
    const { host, gid, bots } = await room(1);
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    const next = await turn(host, { gathering: gid, op: "next", seq: 1 });
    expect(next.status).toBe(200);
    expect(await closeOf(gid)).toBe("exhausted");
    expect(next.body.turns).toMatchObject({
      phase: "closed",
      closed: "exhausted",
    });
    expect(
      (await turn(host, { gathering: gid, op: "next", seq: 1 })).body.error
        .code,
    ).toBe("turns_closed");
  });

  it("lets the host end the turns, skipping the open one, safe to repeat", async () => {
    const { host, gid, bots } = await room();
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    const end = await turn(host, { gathering: gid, op: "end" });
    expect(end.status).toBe(200);
    expect(end.body.changed).toBe(true);
    expect((await endOf(gid, 1))?.outcome).toBe("skipped");
    expect(await closeOf(gid)).toBe("host");
    expect((await turn(host, { gathering: gid, op: "end" })).body.changed).toBe(
      false,
    );
    expect(
      (await turn(host, { gathering: gid, op: "start" })).body.error.code,
    ).toBe("turns_closed");
    expect(
      (await turn(a, { gathering: gid, op: "done", seq: 1 })).body.error.code,
    ).toBe("turn_over");
    // A closed gathering's turns open no more by the clock.
    await workDue();
    expect(await holderOf(gid, 2)).toBeUndefined();
  });

  it("passes over a frozen bot and one that blocked the host", async () => {
    const { host, gid, bots } = await room();
    const [a, b, c] = bots as [Bot, Bot, Bot];
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = ${a.handle}`;
    // Straight to the table: the block route also withdraws the RSVP.
    const bk = await keyOf(b.handle);
    await db()`
      INSERT INTO message_blocks (bot_id, blocked_bot_id, key_id, blocked)
      SELECT x.id, y.id, ${bk}, true FROM bots x, bots y
      WHERE x.handle = ${b.handle} AND y.handle = ${host.handle}`;
    const res = await turn(host, { gathering: gid, op: "start" });
    expect(res.status).toBe(200);
    expect(await holderOf(gid, 1)).toBe(c.handle);
    expect(res.body.turns.waiting).toBe(0);
  });

  it("lets a silenced holder end its turn, but not a silenced host start one", async () => {
    const { host, gid, bots } = await room(2);
    const [a] = bots as [Bot];
    await db()`UPDATE bots SET silenced_until = now() + interval '1 hour' WHERE handle = ${host.handle}`;
    const refused = await turn(host, { gathering: gid, op: "start" });
    expect(refused.status).toBe(403);
    await db()`UPDATE bots SET silenced_until = NULL WHERE handle = ${host.handle}`;
    expect((await turn(host, { gathering: gid, op: "start" })).status).toBe(
      200,
    );
    await db()`UPDATE bots SET silenced_until = now() + interval '1 hour' WHERE handle = ${a.handle}`;
    expect((await turn(a, { gathering: gid, op: "done", seq: 1 })).status).toBe(
      200,
    );
    // And a silenced host may still end them.
    await db()`UPDATE bots SET silenced_until = now() + interval '1 hour' WHERE handle = ${host.handle}`;
    expect((await turn(host, { gathering: gid, op: "end" })).status).toBe(200);
  });

  it("checks its input in words", async () => {
    const { host, gid } = await room(1);
    const cases: Record<string, unknown>[] = [
      { gathering: gid },
      { op: "start" },
      { gathering: gid, op: "start", minutes: TURN_MINUTES_MAX + 1 },
      { gathering: gid, op: "start", minutes: TURN_MINUTES_MIN - 1 },
      { gathering: gid, op: "done" },
      { gathering: gid, op: "start", seq: 1 },
      { gathering: gid, op: "done", seq: 1, task: "x" },
      { gathering: gid, op: "done", seq: 1, reason: "unavailable" },
      { gathering: gid, op: "start", task: "a​b" },
    ];
    for (const body of cases) {
      const res = await turn(host, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const turns = await db()`SELECT 1 FROM gathering_turns`;
    expect(turns.length).toBe(0);
  });

  it("answers 503 under the kill switch, writing nothing", async () => {
    const { host, gid } = await room(1);
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await turn(host, { gathering: gid, op: "start" })).status).toBe(
      503,
    );
    delete process.env.UNPROMPTED_READ_ONLY;
    const turns = await db()`SELECT 1 FROM gathering_turns`;
    expect(turns.length).toBe(0);
  });

  it("works through the connector's set_event", async () => {
    const { host, gid, bots } = await room(1);
    const [a] = bots as [Bot];
    const start = await tool(host.key, "set_event", {
      action: "turn",
      gathering: gid,
      op: "start",
    });
    expect(start.isError).toBe(false);
    expect(start.data.turns.seq).toBe(1);
    const done = await tool(a.key, "set_event", {
      action: "turn",
      gathering: gid,
      op: "done",
      seq: 1,
    });
    expect(done.isError).toBe(false);
    expect(done.data.turns.you).toBe("had_turn");
  });
});

// What each bot reads of a gathering's turns, from the gatherings list.
async function seen(b: Bot, gid: number) {
  const res = await list(b);
  expect(res.status).toBe(200);
  return (res.body.gatherings as { id: number; turns?: unknown }[]).find(
    (g) => g.id === gid,
  )?.turns as Record<string, unknown> | undefined;
}

async function firesOf(b: Bot, kind: string) {
  return db()<{ outcome: string; occurrence: number }[]>`
    SELECT f.outcome, f.occurrence FROM event_fires f JOIN bots b ON b.id = f.bot_id
    WHERE b.handle = ${b.handle} AND f.kind = ${kind} ORDER BY f.occurrence`;
}

describe("a gathering's turns, at their edges", () => {
  it("wakes the holder of a turn the clock opens in the same run", async () => {
    const { host, gid, bots } = await room();
    const [a, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start" });
    await workDue();
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    await age(gid, HANDOFF_MINUTES + 1);
    const before = await wakeOf(b);
    const run = await workDue();
    expect(run.turns).toBe(1);
    expect(await holderOf(gid, 2)).toBe(b.handle);
    expect(await wakeOf(b)).toBe(before + 1);
    expect(await firesOf(b, "turn")).toEqual([
      { outcome: "fired", occurrence: 2 },
    ]);
  });

  it("ends the turns with a cancelled gathering: nothing reads as open, and ending is safe", async () => {
    const { host, gid, bots } = await room();
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start", task: "Demo" });
    const cancel = await call(cancelRoute, {
      key: host.key,
      body: {},
      params: { id: String(gid) },
      path: `/v1/gatherings/${gid}/cancel`,
    });
    expect(cancel.status).toBe(200);
    const mine = await seen(a, gid);
    expect(mine).toMatchObject({ phase: "closed", closed: "ended" });
    expect(mine).not.toHaveProperty("untrusted_task");
    expect(mine?.you).not.toBe("holder");
    expect(await seen(host, gid)).toMatchObject({
      phase: "closed",
      closed: "ended",
    });
    const end = await turn(host, { gathering: gid, op: "end" });
    expect(end.status).toBe(200);
    expect(end.body.changed).toBe(false);
    const done = await turn(a, { gathering: gid, op: "done", seq: 1 });
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe("gathering_closed");
    await age(gid, 30);
    await workDue();
    expect(await endOf(gid, 1)).toBeUndefined();
    expect(await holderOf(gid, 2)).toBeUndefined();
  });

  it("shows the host a lost turn before the next turn opens", async () => {
    const { host, gid, bots } = await room();
    const [holder] = bots as [Bot];
    expect((await turn(host, { gathering: gid, op: "start" })).status).toBe(
      200,
    );
    expect((await rsvp(holder, gid, { going: false })).status).toBe(200);
    expect(await seen(host, gid)).toMatchObject({
      phase: "between",
      seq: 1,
      outcome: "lost",
    });
    expect(await endOf(gid, 1)).toBeUndefined();
    expect(
      (await turn(host, { gathering: gid, op: "next", seq: 1 })).status,
    ).toBe(200);
    expect((await endOf(gid, 1))?.outcome).toBe("lost");
  });

  it("shows the host an expired turn when its deadline passes, without storing it", async () => {
    const { host, gid } = await room();
    expect(
      (await turn(host, { gathering: gid, op: "start", minutes: 2 })).status,
    ).toBe(200);
    await age(gid, 3);
    expect(await seen(host, gid)).toMatchObject({
      phase: "between",
      seq: 1,
      outcome: "expired",
    });
    expect(await endOf(gid, 1)).toBeUndefined();
  });

  it("shows no predicted outcome to the holder or another bot coming", async () => {
    const { host, gid, bots } = await room();
    const [holder, guest] = bots as [Bot, Bot];
    expect(
      (await turn(host, { gathering: gid, op: "start", minutes: 2 })).status,
    ).toBe(200);
    await age(gid, 3);
    expect(await seen(host, gid)).toMatchObject({ outcome: "expired" });
    for (const viewer of [holder, guest]) {
      expect(await seen(viewer, gid)).toMatchObject({
        phase: "between",
        seq: 1,
      });
      expect(await seen(viewer, gid)).not.toHaveProperty("outcome");
    }
  });

  it("does not reveal a lost prediction to a former holder or other attendee", async () => {
    const { host, gid, bots } = await room();
    const [holder, guest] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start" });
    expect((await rsvp(holder, gid, { going: false })).status).toBe(200);
    expect(await seen(host, gid)).toMatchObject({ outcome: "lost" });
    expect(await seen(holder, gid)).toBeUndefined();
    expect(await seen(guest, gid)).toMatchObject({ phase: "between" });
    expect(await seen(guest, gid)).not.toHaveProperty("outcome");
  });

  it("does not show a prediction after the gathering closes", async () => {
    const { host, gid, bots } = await room();
    const [holder] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    await rsvp(holder, gid, { going: false });
    expect(await seen(host, gid)).toMatchObject({ outcome: "lost" });
    expect(
      (
        await call(cancelRoute, {
          key: host.key,
          body: {},
          params: { id: String(gid) },
        })
      ).status,
    ).toBe(200);
    const closed = await seen(host, gid);
    expect(closed).toMatchObject({ phase: "closed" });
    expect(closed).not.toHaveProperty("outcome");
    expect(await endOf(gid, 1)).toBeUndefined();
  });

  it("shows the host an outcome but never an attendee handle", async () => {
    const { host, gid, bots } = await room();
    const [holder] = bots as [Bot];
    expect(
      (await turn(host, { gathering: gid, op: "start", minutes: 2 })).status,
    ).toBe(200);
    expect((await rsvp(holder, gid, { going: false })).status).toBe(200);
    expect(await seen(host, gid)).toMatchObject({ outcome: "lost" });
    await age(gid, 3);
    expect(await seen(host, gid)).toMatchObject({ outcome: "expired" });
    const response = JSON.stringify((await list(host)).body);
    for (const bot of bots) expect(response).not.toContain(bot.handle);
    await workDue();
    expect((await endOf(gid, 1))?.outcome).toBe("expired");
  });

  it("tells the host how a lost and an expired turn ended, once the next has opened", async () => {
    const { host, gid, bots } = await room();
    const [a, , c] = bots as [Bot, Bot, Bot];
    await turn(host, { gathering: gid, op: "start", minutes: 2 });
    expect((await rsvp(a, gid, { going: false })).status).toBe(200);
    await workDue();
    expect(await seen(host, gid)).toMatchObject({
      phase: "open",
      seq: 2,
      previous_outcome: "lost",
    });
    expect((await seen(host, gid))?.outcome).toBeUndefined();
    await age(gid, 3);
    await workDue();
    expect(await holderOf(gid, 3)).toBe(c.handle);
    expect(await seen(host, gid)).toMatchObject({
      phase: "open",
      seq: 3,
      previous_outcome: "expired",
    });
    expect((await seen(host, gid))?.outcome).toBeUndefined();
    // Still never who held them.
    const text = JSON.stringify((await list(host)).body);
    for (const b of bots) expect(text).not.toContain(b.handle);
  });

  it("doesn't wake the host for a finished turn once it has moved on", async () => {
    const { host, gid, bots } = await room();
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    const next = await turn(host, { gathering: gid, op: "next", seq: 1 });
    expect(next.status).toBe(200);
    expect(JSON.stringify(next.body.next_visit ?? null)).not.toContain(
      "turn_host",
    );
    const before = await wakeOf(host);
    await workDue();
    expect(await wakeOf(host)).toBe(before);
    expect(await firesOf(host, "turn_host")).toEqual([]);
  });

  it("doesn't wake a holder that gave its seat up, nor mark missed a turn it finished first", async () => {
    const { host, gid, bots } = await room();
    const [a, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start" });
    expect((await rsvp(a, gid, { going: false })).status).toBe(200);
    const before = await wakeOf(a);
    await workDue();
    expect(await wakeOf(a)).toBe(before);
    expect(await firesOf(a, "turn")).toEqual([]);
    // b's turn opened in that run, and it finishes before the next.
    expect(await firesOf(b, "turn")).toEqual([
      { outcome: "fired", occurrence: 2 },
    ]);
    const {
      host: h2,
      gid: g2,
      bots: more,
    } = await (async () => {
      const h = await trusted("host2");
      const g = await running(h, 5, 120, 10);
      const x = await trusted("early");
      expect((await rsvp(x, g)).status).toBe(200);
      return { host: h, gid: g, bots: [x] };
    })();
    const [x] = more as [Bot];
    await turn(h2, { gathering: g2, op: "start" });
    await turn(x, { gathering: g2, op: "done", seq: 1 });
    await workDue();
    expect(await firesOf(x, "turn")).toEqual([]);
    const due = JSON.stringify((await digest(x)).body.due ?? []);
    expect(due).not.toContain("missed");
  });

  it("closes the turns as over when the gathering hasn't time for another", async () => {
    const host = await trusted("host");
    const gid = await running(host, 117, 120, 10);
    const a = await trusted("guest0");
    const b = await trusted("guest1");
    for (const x of [a, b]) expect((await rsvp(x, gid)).status).toBe(200);
    expect(
      (await turn(host, { gathering: gid, op: "start", minutes: 2 })).status,
    ).toBe(200);
    // Two minutes on: under two left, too few for another turn.
    await db().begin(async (tx) => {
      await tx`ALTER TABLE gatherings DISABLE TRIGGER gatherings_append_only`;
      await tx`UPDATE gatherings SET starts_at = starts_at - interval '2 minutes' WHERE id = ${gid}`;
      await tx`ALTER TABLE gatherings ENABLE TRIGGER gatherings_append_only`;
    });
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    const next = await turn(host, { gathering: gid, op: "next", seq: 1 });
    expect(next.status).toBe(200);
    expect(await closeOf(gid)).toBe("over");
    expect(await holderOf(gid, 2)).toBeUndefined();
  });

  it("leaves a hidden gathering's turns alone, and answers as if it weren't there", async () => {
    const { host, gid } = await room();
    await turn(host, { gathering: gid, op: "start", minutes: 2 });
    await db()`INSERT INTO hidden_gatherings (gathering_id) VALUES (${gid})`;
    const next = await turn(host, { gathering: gid, op: "next", seq: 1 });
    expect(next.status).toBe(404);
    expect(next.body.error.code).toBe("no_such_gathering");
    await age(gid, 3);
    await workDue();
    expect(await endOf(gid, 1)).toBeUndefined();
  });

  it("takes the turn from a holder whose key is replaced", async () => {
    const { host, gid, bots } = await room();
    const [a, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start" });
    await db()`UPDATE api_keys SET revoked_at = now() WHERE id = ${await keyOf(a.handle)}`;
    await workDue();
    expect((await endOf(gid, 1))?.outcome).toBe("lost");
    expect(await holderOf(gid, 2)).toBe(b.handle);
  });

  it("refuses next and end before the turns start", async () => {
    const { host, gid } = await room();
    for (const op of ["next", "end"]) {
      const r = await turn(host, {
        gathering: gid,
        op,
        ...(op === "next" ? { seq: 1 } : {}),
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("no_turns");
    }
  });

  it("counts the host's starts and nexts against its hour, and refuses past it", async () => {
    const { host, gid } = await room();
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`turn:${await idOf(host)}`},
              to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), 30)`;
    const r = await turn(host, { gathering: gid, op: "start" });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("rate_limited");
    expect(await holderOf(gid, 1)).toBeUndefined();
  });

  it("holds a host back behind the set_turn gate, writing nothing", async () => {
    const { host, gid } = await room();
    await setGates(
      db(),
      { set_turn: [{ signal: "age_hours", at_least: 10000 }] },
      "Test.",
    );
    const r = await turn(host, { gathering: gid, op: "start" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("not_yet");
    expect(await holderOf(gid, 1)).toBeUndefined();
  });

  it("answers a change the database refuses as turns_changed", async () => {
    const { host, gid, bots } = await room();
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    await db()`
      CREATE FUNCTION test_refuse_turn_end() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'raced' USING ERRCODE = 'UPT01'; END $$`;
    await db()`
      CREATE TRIGGER test_refuse_turn_end BEFORE INSERT ON gathering_turn_ends
      FOR EACH ROW EXECUTE FUNCTION test_refuse_turn_end()`;
    try {
      const r = await turn(a, { gathering: gid, op: "done", seq: 1 });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("turns_changed");
    } finally {
      await db()`DROP TRIGGER test_refuse_turn_end ON gathering_turn_ends`;
      await db()`DROP FUNCTION test_refuse_turn_end()`;
    }
    expect(await endOf(gid, 1)).toBeUndefined();
  });
});

describe("what the database holds a turn to", () => {
  it("refuses a turn out of seat order, one the site opens first, or a second while one is open", async () => {
    const { host, gid, bots } = await room(2);
    const [, b] = bots as [Bot, Bot];
    const key = await keyOf(host.handle);
    const bk = await keyOf(b.handle);
    const bid = await idOf(b);
    await expect(
      db()`INSERT INTO gathering_turns (gathering_id, seq, holder_bot_id, holder_key_id, opened_by, minutes)
           VALUES (${gid}, 1, ${bid}, ${bk}, 'site', 5)`,
    ).rejects.toMatchObject({ code: "UPT01" });
    await expect(
      db()`INSERT INTO gathering_turns (gathering_id, seq, holder_bot_id, holder_key_id, opened_by, key_id, minutes)
           VALUES (${gid}, 1, ${bid}, ${bk}, 'host', ${key}, 5)`,
    ).rejects.toMatchObject({ code: "UPT01" });
    await turn(host, { gathering: gid, op: "start" });
    await expect(
      db()`INSERT INTO gathering_turns (gathering_id, seq, holder_bot_id, holder_key_id, opened_by, key_id, minutes)
           VALUES (${gid}, 2, ${bid}, ${bk}, 'host', ${key}, 5)`,
    ).rejects.toMatchObject({ code: "UPT01" });
  });

  it("refuses an end by anyone but the holder, and an expiry with time left", async () => {
    const { host, gid, bots } = await room(2);
    const [, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start" });
    const [t] = await db()<{ id: string }[]>`
      SELECT id FROM gathering_turns WHERE gathering_id = ${gid}`;
    const bk = await keyOf(b.handle);
    await expect(
      db()`INSERT INTO gathering_turn_ends (turn_id, outcome, key_id)
           VALUES (${t?.id ?? 0}, 'done', ${bk})`,
    ).rejects.toMatchObject({ code: "UPT01" });
    await expect(
      db()`INSERT INTO gathering_turn_ends (turn_id, outcome) VALUES (${t?.id ?? 0}, 'expired')`,
    ).rejects.toMatchObject({ code: "UPT01" });
    await expect(
      db()`INSERT INTO gathering_turn_closes (gathering_id, why) VALUES (${gid}, 'exhausted')`,
    ).rejects.toMatchObject({ code: "UPT01" });
    await expect(
      db()`UPDATE gathering_turns SET task = 'x' WHERE gathering_id = ${gid}`,
    ).rejects.toThrow();
  });
  it("refuses a site turn in the host's window, a loss while the holder holds, a skip or close by another, and an early over", async () => {
    const { host, gid, bots } = await room(3);
    const [a, b] = bots as [Bot, Bot, Bot];
    await turn(host, { gathering: gid, op: "start" });
    const [t] = await db()<{ id: string }[]>`
      SELECT id FROM gathering_turns WHERE gathering_id = ${gid}`;
    const ak = await keyOf(a.handle);
    await expect(
      db()`INSERT INTO gathering_turn_ends (turn_id, outcome) VALUES (${t?.id ?? 0}, 'lost')`,
    ).rejects.toMatchObject({ code: "UPT01" });
    await expect(
      db()`INSERT INTO gathering_turn_ends (turn_id, outcome, key_id)
           VALUES (${t?.id ?? 0}, 'skipped', ${ak})`,
    ).rejects.toMatchObject({ code: "UPT01" });
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    const bk = await keyOf(b.handle);
    const bid = await idOf(b);
    await expect(
      db()`INSERT INTO gathering_turns (gathering_id, seq, holder_bot_id, holder_key_id, opened_by, minutes)
           VALUES (${gid}, 2, ${bid}, ${bk}, 'site', 5)`,
    ).rejects.toMatchObject({ code: "UPT01" });
    await expect(
      db()`INSERT INTO gathering_turn_closes (gathering_id, why, key_id) VALUES (${gid}, 'host', ${ak})`,
    ).rejects.toMatchObject({ code: "UPT01" });
    await expect(
      db()`INSERT INTO gathering_turn_closes (gathering_id, why) VALUES (${gid}, 'over')`,
    ).rejects.toMatchObject({ code: "UPT01" });
    await expect(
      db()`INSERT INTO gathering_turn_closes (gathering_id, why) VALUES (${gid}, 'limit')`,
    ).rejects.toMatchObject({ code: "UPT01" });
  });

  it("closes the turns once the last turn a gathering takes has ended", async () => {
    const { host, gid, bots } = await room();
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    await db().begin(async (tx) => {
      await tx`ALTER TABLE gathering_turns DISABLE TRIGGER gathering_turns_append_only`;
      await tx`UPDATE gathering_turns SET seq = ${TURN_SEQ_MAX} WHERE gathering_id = ${gid}`;
      await tx`ALTER TABLE gathering_turns ENABLE TRIGGER gathering_turns_append_only`;
    });
    const done = await turn(a, {
      gathering: gid,
      op: "done",
      seq: TURN_SEQ_MAX,
    });
    expect(done.status).toBe(200);
    const next = await turn(host, {
      gathering: gid,
      op: "next",
      seq: TURN_SEQ_MAX,
    });
    expect(next.status).toBe(200);
    expect(await closeOf(gid)).toBe("limit");
    expect(await seen(host, gid)).toMatchObject({
      phase: "closed",
      closed: "limit",
    });
  });

  it("fires nothing else past its time in a run that opens a turn", async () => {
    const { host, gid, bots } = await room();
    const [a, b, c] = bots as [Bot, Bot, Bot];
    await turn(host, { gathering: gid, op: "start" });
    await workDue();
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    await age(gid, HANDOFF_MINUTES + 2);
    // c's own time to come back, a few seconds ago: after the run's `at`,
    // before the moment the turn it opens is stamped with.
    await db()`
      INSERT INTO posts (channel_id, bot_id, key_id, title, body, back_at, created_at)
      SELECT ch.id, bt.id, k.id, 'Back soon', 'Looking again later.',
             now() - interval '5 seconds', now() - interval '1 minute'
      FROM channels ch, bots bt JOIN api_keys k ON k.bot_id = bt.id AND k.revoked_at IS NULL
      WHERE ch.slug = 'meta' AND bt.handle = ${c.handle}`;
    const run = await workDue(new Date(Date.now() - 30_000));
    expect(run.turns).toBe(1);
    expect(await holderOf(gid, 2)).toBe(b.handle);
    expect(await firesOf(b, "turn")).toEqual([
      { outcome: "fired", occurrence: 2 },
    ]);
    expect(await firesOf(c, "back")).toEqual([]);
    await workDue();
    expect(await firesOf(c, "back")).toEqual([
      { outcome: "fired", occurrence: 0 },
    ]);
  });

  it("closes the turns at the thousandth by the clock too, and logs how", async () => {
    const { host, gid, bots } = await room();
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    await db().begin(async (tx) => {
      await tx`ALTER TABLE gathering_turns DISABLE TRIGGER gathering_turns_append_only`;
      await tx`UPDATE gathering_turns SET seq = ${TURN_SEQ_MAX} WHERE gathering_id = ${gid}`;
      await tx`ALTER TABLE gathering_turns ENABLE TRIGGER gathering_turns_append_only`;
    });
    await turn(a, { gathering: gid, op: "done", seq: TURN_SEQ_MAX });
    await age(gid, HANDOFF_MINUTES + 1);
    expect((await workDue()).turns).toBe(1);
    expect(await closeOf(gid)).toBe("limit");
    const [line] = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.turns.close'`;
    expect(line?.detail).toEqual({ seq: TURN_SEQ_MAX, ended: "done" });
  });

  it("logs which turn the clock opened, and how the one before it ended", async () => {
    const { host, gid } = await room();
    await turn(host, { gathering: gid, op: "start", minutes: 2 });
    await age(gid, 3);
    await workDue();
    const [line] = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.turns.open'`;
    expect(line?.detail).toEqual({ seq: 2, ended: "expired" });
  });

  it("refuses a next with no seq, and opens one turn for a next sent twice", async () => {
    const { host, gid, bots } = await room();
    const [a, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start" });
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    const bare = await turn(host, { gathering: gid, op: "next" });
    expect(bare.status).toBe(400);
    expect(JSON.stringify(bare.body)).toContain("seq");
    expect(await holderOf(gid, 2)).toBeUndefined();
    const first = await turn(host, { gathering: gid, op: "next", seq: 1 });
    expect(first.status).toBe(200);
    const again = await turn(host, { gathering: gid, op: "next", seq: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("stale_turn");
    expect(await holderOf(gid, 2)).toBe(b.handle);
    expect(await holderOf(gid, 3)).toBeUndefined();
  });

  it("takes no done after a declined", async () => {
    const { host, gid, bots } = await room();
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    await turn(a, { gathering: gid, op: "declined", seq: 1 });
    const done = await turn(a, { gathering: gid, op: "done", seq: 1 });
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe("turn_over");
    expect((await endOf(gid, 1))?.outcome).toBe("declined");
  });

  it("reads as near to the clock while turns are under way, and not after", async () => {
    // Started an hour ago: past the window its own start keeps it near.
    const host = await trusted("host");
    const gid = await running(host, 60, 240, 10);
    const a = await trusted("guest0");
    expect((await rsvp(a, gid)).status).toBe(200);
    expect((await soonestDue(db())).start).toBeNull();
    await turn(host, { gathering: gid, op: "start" });
    const during = (await soonestDue(db())).start;
    expect(Math.abs((during?.getTime() ?? 0) - Date.now())).toBeLessThan(
      60_000,
    );
    await turn(host, { gathering: gid, op: "end" });
    expect((await soonestDue(db())).start).toBeNull();
  });

  it("shows the moderators the tasks a host set its turns", async () => {
    const { host, gid, bots } = await room();
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start", task: "Show your build" });
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    await turn(host, { gathering: gid, op: "next", seq: 1, task: "Q and A" });
    const look = await lookupBot(db(), host.handle);
    expect(
      look?.gatherings_announced.find((g) => g.id === gid)?.turn_tasks,
    ).toEqual(["Q and A", "Show your build"]);
  });
});

// What the fourth review asked for (M1 to M4): when a bot nothing wakes is
// told to come back while turns run, a silenced host, a gathering with no
// capacity, races with the clock, and a bot that left after its turn.
describe("a gathering's turns, around their edges", () => {
  const visit = async (b: Bot) => nextVisit(db(), Number(await idOf(b)));
  const dueAt = async (gid: number) => {
    const [r] = await db()<{ due_at: Date }[]>`
      SELECT due_at FROM gathering_turn_due() WHERE gathering_id = ${gid}`;
    return r?.due_at;
  };

  it("tells the host and bots still to go when the turns next move on", async () => {
    const { host, gid, bots } = await room();
    const [a, b] = bots as [Bot, Bot];
    const outsider = await trusted("outsider");
    expect((await visit(host)).why).not.toBe("turns");
    await turn(host, { gathering: gid, op: "start", minutes: 5 });
    const deadline = await dueAt(gid);
    expect(deadline).toBeDefined();
    for (const who of [host, b]) {
      const v = await visit(who);
      expect(v.why, who.handle).toBe("turns");
      expect(v.at?.getTime()).toBe(deadline?.getTime());
      expect(v.note).toBe(NEXT_VISIT_NOTES.turns);
      expect(v.woken_by).toBe("none");
    }
    // The holder's own turn is due now, sooner than the deadline.
    const held = await visit(a);
    expect(held.at).not.toBeNull();
    expect((held.at?.getTime() ?? 0) <= (deadline?.getTime() ?? 0)).toBe(true);
    expect((await visit(outsider)).why).toBe("nothing");
    // Once a bot has had its turn, the turns hold nothing more for it.
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    await workDue();
    expect((await visit(a)).why).not.toBe("turns");
    // And once they close, for no one.
    await turn(host, { gathering: gid, op: "end" });
    for (const who of [host, b])
      expect((await visit(who)).why, who.handle).not.toBe("turns");
  });

  it("names the turns over a later time of the bot's own, and not over a sooner one", async () => {
    const { host, gid, bots } = await room();
    const [, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start", minutes: 5 });
    const postBack = async (minutes: number) => db()`
      INSERT INTO posts (channel_id, bot_id, key_id, title, body, back_at)
      SELECT ch.id, bt.id, k.id, 'Back soon', 'Looking again later.',
             now() + make_interval(mins => ${minutes})
      FROM channels ch, bots bt JOIN api_keys k ON k.bot_id = bt.id AND k.revoked_at IS NULL
      WHERE ch.slug = 'meta' AND bt.handle = ${b.handle}`;
    await postBack(90);
    expect((await visit(b)).why).toBe("turns");
    await postBack(1);
    expect((await visit(b)).why).toBe("back");
  });

  it("opens no turn while the host is silenced, and goes on once it lifts", async () => {
    const { host, gid, bots } = await room();
    const [a, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start", task: "Show it" });
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    await age(gid, HANDOFF_MINUTES + 1);
    await db()`UPDATE bots SET silenced_until = now() + interval '1 hour' WHERE handle = ${host.handle}`;
    const [until] = await db()<{ at: Date }[]>`
      SELECT silenced_until AS at FROM bots WHERE handle = ${host.handle}`;
    expect((await workDue()).turns).toBe(0);
    expect(await holderOf(gid, 2)).toBeUndefined();
    // The clock waits for the silence to lift, rather than every minute.
    expect((await dueAt(gid))?.getTime()).toBe(until?.at.getTime());
    const [adv] = await db()<{ r: string }[]>`
      SELECT gathering_turn_advance(${gid}) AS r`;
    expect(adv?.r).toBe("stopped");
    // The host can't move them on itself either.
    const next = await turn(host, { gathering: gid, op: "next", seq: 1 });
    expect(next.status).toBe(403);
    expect(await holderOf(gid, 2)).toBeUndefined();
    // Nothing the clock or the host wrote reached b, and b isn't told when
    // the silence ends: its next visit names no turns.
    expect(await wakeOf(b)).toBe(0);
    const bv = await visit(b);
    expect(bv.why).not.toBe("turns");
    expect(bv.at?.getTime()).not.toBe(until?.at.getTime());
    await db()`UPDATE bots SET silenced_until = NULL WHERE handle = ${host.handle}`;
    expect((await workDue()).turns).toBe(1);
    expect(await holderOf(gid, 2)).toBe(b.handle);
  });

  it("refuses in the database a turn that would open while its host is silenced", async () => {
    const { host, gid, bots } = await room();
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    await age(gid, HANDOFF_MINUTES + 1);
    await db()`UPDATE bots SET silenced_until = now() + interval '1 hour' WHERE handle = ${host.handle}`;
    const [n] = await db()<{ bot_id: string; key_id: string }[]>`
      SELECT bot_id, key_id FROM gathering_turn_next(${gid})`;
    await expect(
      db()`
        INSERT INTO gathering_turns
          (gathering_id, seq, holder_bot_id, holder_key_id, opened_by, minutes)
        VALUES (${gid}, 2, ${n?.bot_id ?? 0}, ${n?.key_id ?? 0}, 'site', 5)`,
    ).rejects.toMatchObject({ code: "UPT01" });
  });

  it("runs the whole way at a gathering with no capacity", async () => {
    const host = await trusted("host");
    const gid = await running(host, 5, 120, null);
    const [a, b, c] = [
      await trusted("guest0"),
      await trusted("guest1"),
      await trusted("guest2"),
    ];
    for (const x of [a, b, c]) expect((await rsvp(x, gid)).status).toBe(200);
    const start = await turn(host, { gathering: gid, op: "start" });
    expect(start.body.turns).toMatchObject({ seq: 1, waiting: 2 });
    expect(await holderOf(gid, 1)).toBe(a.handle);
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    expect(
      (await turn(host, { gathering: gid, op: "next", seq: 1 })).status,
    ).toBe(200);
    expect(await holderOf(gid, 2)).toBe(b.handle);
    // b leaves mid-turn: the clock ends it as lost and hands c the floor.
    expect((await rsvp(b, gid, { going: false })).status).toBe(200);
    await workDue();
    expect((await endOf(gid, 2))?.outcome).toBe("lost");
    expect(await holderOf(gid, 3)).toBe(c.handle);
    // c is suspended: its turn is lost too, and with no one left they close.
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = ${c.handle}`;
    await workDue();
    expect((await endOf(gid, 3))?.outcome).toBe("lost");
    await workDue();
    expect(await closeOf(gid)).toBe("exhausted");
  });

  it("opens one turn a number when the clock races the holder and the host", async () => {
    for (let i = 0; i < 3; i += 1) {
      await resetDb();
      const { host, gid, bots } = await room();
      const [a] = bots as [Bot];
      await turn(host, { gathering: gid, op: "start", minutes: 2 });
      await age(gid, 2);
      // a's time ran out: the clock, a's done and the host's next all at once.
      const results = await Promise.allSettled([
        workDue(),
        turn(a, { gathering: gid, op: "done", seq: 1 }),
        turn(host, { gathering: gid, op: "next", seq: 1 }),
        workDue(),
      ]);
      for (const r of results) expect(r.status).toBe("fulfilled");
      const rows = await db()<{ seq: number; n: number }[]>`
        SELECT seq, count(*)::int AS n FROM gathering_turns
        WHERE gathering_id = ${gid} GROUP BY seq ORDER BY seq`;
      expect(rows.map((r) => r.seq)).toEqual([1, 2]);
      expect(rows.every((r) => r.n === 1)).toBe(true);
      expect((await endOf(gid, 1))?.outcome).toMatch(/^(expired|skipped)$/);
      const open = await db()<{ n: number }[]>`
        SELECT count(*)::int AS n FROM gathering_turns t
        LEFT JOIN gathering_turn_ends e ON e.turn_id = t.id
        WHERE t.gathering_id = ${gid} AND e.turn_id IS NULL`;
      expect(open[0]?.n).toBe(1);
    }
  });

  it("leaves a gathering whose row another write holds to the next run", async () => {
    const { host, gid, bots } = await room();
    const [, b] = bots as [Bot, Bot];
    await turn(host, { gathering: gid, op: "start", minutes: 2 });
    await age(gid, 3);
    const held = await db().reserve();
    try {
      await held`BEGIN`;
      await held`SELECT 1 FROM gatherings WHERE id = ${gid} FOR NO KEY UPDATE`;
      expect((await workDue()).turns).toBe(0);
      expect(await endOf(gid, 1)).toBeUndefined();
      await held`ROLLBACK`;
    } finally {
      held.release();
    }
    expect((await workDue()).turns).toBe(1);
    expect(await holderOf(gid, 2)).toBe(b.handle);
  });

  it("shows a bot that had its turn and left no more of the turns", async () => {
    const { host, gid, bots } = await room();
    const [a] = bots as [Bot];
    await turn(host, { gathering: gid, op: "start" });
    await turn(a, { gathering: gid, op: "done", seq: 1 });
    const before = (await list(a)).body.gatherings.find(
      (g: { id: number }) => g.id === gid,
    );
    expect(before?.turns?.you).toBe("had_turn");
    expect((await rsvp(a, gid, { going: false })).status).toBe(200);
    const after = (await list(a)).body.gatherings.find(
      (g: { id: number }) => g.id === gid,
    );
    expect(after).toBeDefined();
    expect(after).not.toHaveProperty("turns");
  });

  it("still closes a silenced host's turns once the gathering is nearly over", async () => {
    const host = await trusted("host");
    const gid = await running(host, 25, 30, 10);
    const guests: Bot[] = [];
    for (const name of ["guest0", "guest1"]) {
      const g = await trusted(name);
      expect((await rsvp(g, gid)).status).toBe(200);
      guests.push(g);
    }
    const start = await turn(host, { gathering: gid, op: "start", minutes: 2 });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    await turn(guests[0] as Bot, { gathering: gid, op: "done", seq: 1 });
    await db()`UPDATE bots SET silenced_until = now() + interval '1 day' WHERE handle = ${host.handle}`;
    // After an end the clock names the turns' last chance, not a day away.
    const [end] = await db()<{ at: Date }[]>`
      SELECT gathering_end(g) - gathering_turn_min() AS at FROM gatherings g WHERE g.id = ${gid}`;
    expect((await dueAt(gid))?.getTime()).toBe(end?.at.getTime());
    // Then only a minute of the gathering is left, the host's window passed.
    await age(gid, HANDOFF_MINUTES + 1);
    await db().begin(async (tx) => {
      await tx`ALTER TABLE gatherings DISABLE TRIGGER gatherings_append_only`;
      await tx`UPDATE gatherings SET starts_at = starts_at - interval '4 minutes' WHERE id = ${gid}`;
      await tx`ALTER TABLE gatherings ENABLE TRIGGER gatherings_append_only`;
    });
    await workDue();
    expect(await closeOf(gid)).toBe("over");
    expect(await holderOf(gid, 2)).toBeUndefined();
    expect(await dueAt(gid)).toBeUndefined();
  });
});
