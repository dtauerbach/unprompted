import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  POST as blockRoute,
  DELETE as unblockRoute,
} from "@/app/v1/bots/[handle]/block/route";
import { POST as cancelRoute } from "@/app/v1/gatherings/[id]/cancel/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { GET as listRoute } from "@/app/v1/gatherings/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as pushRoute } from "@/app/v1/me/push/route";
import { setFrozen, setSilenced } from "@/lib/admin";
import { db } from "@/lib/db";
import { forgetDueMinute } from "@/lib/due-check";
import { RSVP_NOTES } from "@/lib/gatherings";
import { CANT_REASONS } from "@/lib/validate";
import { call, freshIp, register, resetDb } from "./helpers";

// "I can't do it" for a gathering (EV15a, 083_seat_released.sql, R187): a
// bot that was coming withdraws, optionally saying why from a fixed list.
// Only it sees its reason. The announcer is woken once per bot, at once, a
// block's withdrawal included, and reads only when a seat last opened up,
// never who or why.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

async function wakeCount(b: Bot): Promise<number> {
  const [r] = await db()<{ count: string }[]>`
    SELECT w.count FROM wake_counters w JOIN bots b ON b.id = w.bot_id
    WHERE b.handle = ${b.handle}`;
  return Number(r?.count ?? 0);
}

async function count(table: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${db()(table)}`;
  return r?.n ?? 0;
}

// Written straight to the table, so a test needn't clear the announce gate.
async function gathering(host: Bot, inMinutes = 60): Promise<number> {
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, created_at)
    SELECT b.id, k.id, 'Jam', now() + make_interval(mins => ${inMinutes}),
           now() - interval '1 hour'
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

describe("withdrawing with a reason", () => {
  it("shows the reason to the bot alone and wakes the announcer once", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const b = await register("guest-b");
    const id = await gathering(host);
    expect((await rsvp(a, id, { going: true })).status).toBe(200);
    expect((await rsvp(b, id, { going: true })).status).toBe(200);
    const before = await wakeCount(host);
    const beforeB = await wakeCount(b);
    const res = await rsvp(a, id, { going: false, reason: "missing_input" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.rsvp.going).toBe(false);
    expect(res.body.rsvp.reason).toBe("missing_input");
    expect(res.body.note).toBe(RSVP_NOTES.withdrawn);
    expect(res.body.gathering.coming).toBe(1);
    // The bot's own view of the gathering carries no seat time.
    expect(res.body.gathering.seat_opened_at).toBeUndefined();
    expect(await wakeCount(host)).toBe(before + 1);
    // The other guest isn't woken and learns nothing new.
    expect(await wakeCount(b)).toBe(beforeB);
    const theirs = await viewOf(b, id);
    expect(theirs.seat_opened_at).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain("missing_input");
    // The announcer sees when, to the minute, and never who or why.
    const mine = await viewOf(host, id);
    expect(mine.yours).toBe(true);
    expect(mine.coming).toBe(1);
    const at = Date.parse(mine.seat_opened_at);
    expect(at % 60_000).toBe(0);
    expect(Date.now() - at).toBeLessThan(2 * 60_000);
    expect(JSON.stringify(mine)).not.toContain("missing_input");
    expect(JSON.stringify(mine)).not.toContain("guest-a");
  });

  it("takes every reason on the list, and works without one", async () => {
    const host = await register("host");
    const id = await gathering(host);
    for (const [i, reason] of CANT_REASONS.entries()) {
      const bot = await register(`guest-${i}`);
      await rsvp(bot, id, { going: true });
      const res = await rsvp(bot, id, { going: false, reason });
      expect(res.status).toBe(200);
      expect(res.body.rsvp.reason).toBe(reason);
    }
    const plain = await register("plain");
    await rsvp(plain, id, { going: true });
    const before = await wakeCount(host);
    const res = await rsvp(plain, id, { going: false });
    expect(res.status).toBe(200);
    expect(res.body.rsvp.reason).toBeUndefined();
    // No reason is still a real answer: the seat opened and the host hears.
    expect(await wakeCount(host)).toBe(before + 1);
  });

  it("refuses free text, an unknown reason and a reason with going: true", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    const rows = await count("gathering_rsvps");
    for (const body of [
      { going: false, reason: "my person is ill" },
      { going: false, reason: "declined" },
      { going: false, reason: "" },
      { going: false, reason: null },
      { going: true, reason: "unavailable" },
      { going: false, reason: "unavailable", why: "busy" },
    ]) {
      const res = await rsvp(a, id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid");
    }
    expect(await count("gathering_rsvps")).toBe(rows);
  });

  it("never puts the reason in the action log, only that a seat opened", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    await rsvp(a, id, { going: false, reason: "cant_perform" });
    const rows = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.rsvp'
      ORDER BY id`;
    expect(rows.at(-1)?.detail).toEqual({
      going: false,
      notice_minutes: null,
      seat_opened: true,
    });
    const all = await db()<{ t: string }[]>`
      SELECT row_to_json(l)::text AS t FROM action_log l`;
    for (const r of all) expect(r.t).not.toContain("cant_perform");
  });
});

describe("the announcer's wake", () => {
  it("comes once per bot, however often it comes and goes", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    const start = await wakeCount(host);
    for (let i = 0; i < 3; i++) {
      await rsvp(a, id, { going: true });
      await rsvp(a, id, { going: false, reason: "unavailable" });
    }
    expect(await wakeCount(host)).toBe(start + 1);
    // Only the first withdrawal opens a seat, so seat_opened_at never moves
    // without a wake: a later one would tell the announcer it's a bot that
    // left before.
    const [opened] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM gathering_rsvps x
      JOIN bots b ON b.id = x.bot_id
      WHERE b.handle = 'guest-a' AND x.seat_opened`;
    expect(opened?.n).toBe(1);
    // A second bot opening a seat wakes it once more.
    const b = await register("guest-b");
    await rsvp(b, id, { going: true });
    await rsvp(b, id, { going: false });
    expect(await wakeCount(host)).toBe(start + 2);
  });

  it("is safe to repeat: a second withdrawal writes nothing and answers the same", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    await rsvp(a, id, { going: false, reason: "prefer_not_to_say" });
    const rows = await count("gathering_rsvps");
    const wakes = await wakeCount(host);
    const again = await rsvp(a, id, { going: false, reason: "unavailable" });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    // The reason it gave, not the retry's: nothing was written.
    expect(again.body.rsvp.reason).toBe("prefer_not_to_say");
    expect(await count("gathering_rsvps")).toBe(rows);
    expect(await wakeCount(host)).toBe(wakes);
  });

  it("doesn't come for a bot that was never coming", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    const wakes = await wakeCount(host);
    const res = await rsvp(a, id, { going: false, reason: "unavailable" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.rsvp.reason).toBeUndefined();
    expect(await count("gathering_rsvps")).toBe(0);
    expect(await wakeCount(host)).toBe(wakes);
    expect((await viewOf(host, id)).seat_opened_at).toBeUndefined();
  });

  it("doesn't come for the announcer's own RSVP", async () => {
    const host = await register("host");
    const id = await gathering(host);
    await rsvp(host, id, { going: true });
    const wakes = await wakeCount(host);
    const res = await rsvp(host, id, { going: false, reason: "unavailable" });
    expect(res.status).toBe(200);
    expect(res.body.rsvp.reason).toBe("unavailable");
    expect(await wakeCount(host)).toBe(wakes);
    expect((await viewOf(host, id)).seat_opened_at).toBeUndefined();
  });

  it("comes for a block like any withdrawal, so a block looks like a no", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    expect((await viewOf(host, id)).coming).toBe(1);
    const wakes = await wakeCount(host);
    // A block writes a withdrawal (writeRsvpEnds): it opens a seat as a no
    // would, with no reason, so the announcer can't tell the two apart.
    await call(blockRoute, { key: a.key, params: { handle: "host" } });
    expect(await wakeCount(host)).toBe(wakes + 1);
    const [row] = await db()<{ seat_opened: boolean; reason: string | null }[]>`
      SELECT seat_opened, reason FROM gathering_rsvps ORDER BY id DESC LIMIT 1`;
    expect(row).toEqual({ seat_opened: true, reason: null });
    const seen = await viewOf(host, id);
    expect(seen.coming).toBe(0);
    expect(typeof seen.seat_opened_at).toBe("string");
    // Unblocking and coming and going again opens nothing more.
    await call(unblockRoute, {
      key: a.key,
      method: "DELETE",
      params: { handle: "host" },
    });
    await rsvp(a, id, { going: true });
    await rsvp(a, id, { going: false });
    expect(await wakeCount(host)).toBe(wakes + 1);
  });

  it("doesn't come for a block by a bot that already left: it opened its seat then", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    await rsvp(a, id, { going: false });
    const wakes = await wakeCount(host);
    await call(blockRoute, { key: a.key, params: { handle: "host" } });
    expect(await wakeCount(host)).toBe(wakes);
  });

  it("opens a seat on each of the host's gatherings a block ends, as coming already showed", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const one = await gathering(host, 60);
    const two = await gathering(host, 90);
    await rsvp(a, one, { going: true });
    await rsvp(a, two, { going: true });
    const wakes = await wakeCount(host);
    await call(blockRoute, { key: a.key, params: { handle: "host" } });
    // Accepted (AGENTS.md): both counts dropped at once before this change.
    expect(await wakeCount(host)).toBe(wakes + 2);
    expect((await viewOf(host, one)).coming).toBe(0);
    expect((await viewOf(host, two)).coming).toBe(0);
  });

  it("opens no seat on a gathering a moderator hid, which a block still reaches", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    await db()`INSERT INTO hidden_gatherings (gathering_id) VALUES (${id})`;
    const wakes = await wakeCount(host);
    await call(blockRoute, { key: a.key, params: { handle: "host" } });
    expect(await wakeCount(host)).toBe(wakes);
    const rows = await db()<{ seat_opened: boolean }[]>`
      SELECT seat_opened FROM gathering_rsvps WHERE key_id IS NULL`;
    expect(rows.map((r) => r.seat_opened)).toEqual([false]);
  });

  it("keeps no reason sent with a withdrawal that ends nothing, and says so", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    await rsvp(a, id, { going: false });
    const late = await rsvp(a, id, { going: false, reason: "cant_perform" });
    expect(late.status).toBe(200);
    expect(late.body.changed).toBe(false);
    expect(late.body.rsvp.reason).toBeUndefined();
    expect(late.body.note).toBe(RSVP_NOTES.withdrawn);
    expect(late.body.note).toContain("only with the withdrawal that ended");
  });

  it("doesn't come for a seat that went quiet: a rotated key withdraws nothing", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    const wakes = await wakeCount(host);
    const rows = await count("gathering_rsvps");
    const rotated = await call(rotateRoute, { key: a.key, method: "POST" });
    expect(rotated.status).toBe(200);
    expect(await count("gathering_rsvps")).toBe(rows);
    expect(await wakeCount(host)).toBe(wakes);
    // Withdrawing with the new key now isn't a seat opening: it wasn't in.
    const res = await rsvp(
      { handle: a.handle, key: rotated.body.api_key },
      id,
      { going: false, reason: "unavailable" },
    );
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(await wakeCount(host)).toBe(wakes);
  });

  it("doesn't come once the gathering is cancelled", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    const cancelled = await call(cancelRoute, {
      key: host.key,
      method: "POST",
      params: { id: String(id) },
      path: `/v1/gatherings/${id}/cancel`,
    });
    expect(cancelled.status).toBe(200);
    const wakes = await wakeCount(host);
    const res = await rsvp(a, id, { going: false, reason: "unavailable" });
    expect(res.status).toBe(200);
    expect(await wakeCount(host)).toBe(wakes);
    const [row] = await db()<{ seat_opened: boolean }[]>`
      SELECT seat_opened FROM gathering_rsvps ORDER BY id DESC LIMIT 1`;
    expect(row?.seat_opened).toBe(false);
    expect((await viewOf(host, id))?.seat_opened_at).toBeUndefined();
  });

  it("comes for a silenced bot, which can still withdraw", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    await setSilenced(db(), a.handle, 2, "Testing.");
    const wakes = await wakeCount(host);
    const res = await rsvp(a, id, { going: false, reason: "unavailable" });
    expect(res.status).toBe(200);
    expect(res.body.rsvp.reason).toBe("unavailable");
    expect(await wakeCount(host)).toBe(wakes + 1);
  });

  it("queues the announcer's push, which carries no reason", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const pushed = await call(pushRoute, {
      key: host.key,
      body: { url: "https://hooks.example.org/unprompted" },
    });
    expect(pushed.status).toBe(201);
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    await db()`UPDATE push_state SET pending_since = NULL`;
    await rsvp(a, id, { going: false, reason: "missing_input" });
    const [p] = await db()<{ pending: boolean }[]>`
      SELECT p.pending_since IS NOT NULL AS pending
      FROM push_state p JOIN bots b ON b.id = p.bot_id
      WHERE b.handle = 'host'`;
    expect(p?.pending).toBe(true);
  });

  it("shows in the announcer's catch-up, with a note on what it means", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    await rsvp(a, id, { going: false, reason: "unavailable" });
    const res = await call(digestRoute, {
      key: host.key,
      path: "/v1/me/digest?since=0",
    });
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
    const g = res.body.gatherings.find((x: any) => x.id === id);
    expect(g.seat_opened_at).toBeDefined();
    expect(res.body.gatherings_note).toMatch(/seat_opened_at/);
    expect(JSON.stringify(res.body)).not.toContain("unavailable");
    const theirs = await call(digestRoute, {
      key: a.key,
      path: "/v1/me/digest?since=0",
    });
    expect(JSON.stringify(theirs.body)).not.toContain('seat_opened_at":');
  });
});

describe("the table", () => {
  it("sets seat_opened itself, whatever a writer sends", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    // A coming row can't claim a seat opened; a withdrawal's mark is the
    // site's, not the writer's.
    await expect(db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes, seat_opened)
      SELECT ${id}, b.id, k.id, 10, true FROM bots b
      JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = 'guest-a'`).resolves.toBeDefined();
    const [row] = await db()<{ seat_opened: boolean }[]>`
      SELECT seat_opened FROM gathering_rsvps ORDER BY id DESC LIMIT 1`;
    expect(row?.seat_opened).toBe(false);
    // Nor can a withdrawal by a bot that was never coming claim one.
    const b = await register("guest-b");
    const wakes = await wakeCount(host);
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, seat_opened)
      SELECT ${id}, b.id, true FROM bots b WHERE b.handle = ${b.handle}`;
    const [late] = await db()<{ seat_opened: boolean }[]>`
      SELECT seat_opened FROM gathering_rsvps ORDER BY id DESC LIMIT 1`;
    expect(late?.seat_opened).toBe(false);
    expect(await wakeCount(host)).toBe(wakes);
  });

  it("refuses a reason on a coming row, and stays append-only", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    await expect(db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes, reason)
      SELECT ${id}, b.id, k.id, 10, 'unavailable' FROM bots b
      JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = 'guest-a'`).rejects.toThrow();
    await expect(db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, reason)
      SELECT ${id}, id, 'busy' FROM bots WHERE handle = 'guest-a'`).rejects.toThrow();
    await expect(
      db()`UPDATE gathering_rsvps SET reason = 'unavailable'`,
    ).rejects.toThrow();
  });

  it("doesn't wake a frozen announcer", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    await rsvp(a, id, { going: true });
    await setFrozen(db(), host.handle, true, "Testing.");
    const wakes = await wakeCount(host);
    // Its gathering vanished, so the route refuses; the table still
    // wouldn't wake it.
    expect((await rsvp(a, id, { going: false })).status).toBe(404);
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, reason)
      SELECT ${id}, id, 'unavailable' FROM bots WHERE handle = 'guest-a'`;
    expect(await wakeCount(host)).toBe(wakes);
  });
});

describe("the connector", () => {
  it("takes a reason on rsvp and refuses one with going: true", async () => {
    const host = await register("host");
    const a = await register("guest-a");
    const id = await gathering(host);
    const going = await tool(a.key, "rsvp", { gathering: id, going: true });
    expect(going.isError).toBe(false);
    const wakes = await wakeCount(host);
    const out = await tool(a.key, "rsvp", {
      gathering: id,
      going: false,
      reason: "cant_perform",
    });
    expect(out.isError).toBe(false);
    expect(out.data.rsvp.reason).toBe("cant_perform");
    expect(await wakeCount(host)).toBe(wakes + 1);
    const bad = await tool(a.key, "rsvp", {
      gathering: id,
      going: true,
      reason: "unavailable",
    });
    expect(bad.isError).toBe(true);
  });
});
