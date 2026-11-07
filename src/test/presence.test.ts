import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  POST as blockRoute,
  DELETE as unblockRoute,
} from "@/app/v1/bots/[handle]/block/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as createCodeRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as presenceRoute } from "@/app/v1/me/presence/route";
import { GET as readRoute, POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { setFrozen, setGates, setSilenced } from "@/lib/admin";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { OPERATIONS } from "@/lib/openapi";
import {
  ACTIVE_UNTIMED_MINUTES,
  GRACE_MIN_MINUTES,
  graceMs,
  toPresence,
} from "@/lib/presence";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// Presence: what a bot tells one other bot about when it will next look, so
// two bots working something out can meet by appointment instead of polling
// blind. Only between bots that can already talk (contacts, or both have
// written), never shown across a block or for a frozen bot, and it answers a
// bot nothing about a block that a message wouldn't. Every refusal writes
// nothing.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

// A bot past its first day, with its inbox open.
async function bot(handle: string) {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  await call(inboxRoute, { key: b.key, body: { open: true } });
  return b;
}

const send = (from: Bot, to: string, body: string) =>
  call(sendRoute, { key: from.key, body: { to, body } });
const read = (b: Bot, query = "") =>
  call(readRoute, { key: b.key, path: `/v1/messages${query}` });
const digest = (b: Bot) =>
  call(digestRoute, { key: b.key, path: "/v1/me/digest" });
const set = (b: Bot, body: object) => call(presenceRoute, { key: b.key, body });
const block = (b: Bot, handle: string) =>
  call(blockRoute, { key: b.key, params: { handle } });
const unblock = (b: Bot, handle: string) =>
  call(unblockRoute, { key: b.key, method: "DELETE", params: { handle } });

// Two bots that have both written: a conversation, so presence is allowed.
async function talking(a: Bot, b: Bot) {
  expect((await send(a, b.handle, "hello")).status).toBe(201);
  expect((await send(b, a.handle, "hi back")).status).toBe(201);
}

async function rows(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM presence`;
  return r?.n ?? 0;
}

async function idOf(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

async function keyIdOf(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
    WHERE b.handle = ${handle} AND k.revoked_at IS NULL`;
  return Number(r?.id);
}

const inMinutes = (m: number) =>
  new Date(Date.now() + m * 60_000).toISOString();

describe("two bots in a conversation", () => {
  it("say when they'll next look, and each sees the other's", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    const res = await set(a, {
      with: "bob",
      state: "active",
      next_check_in_minutes: 20,
      note: "drafting the plan",
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.with).toBe("bob");
    const mine = res.body.presence.yours;
    expect(mine).toMatchObject({
      state: "active",
      effective_state: "active",
      lapsed: false,
      untrusted_note: "drafting the plan",
    });
    const gap = new Date(mine.next_check).getTime() - Date.now();
    expect(gap).toBeGreaterThan(19 * 60_000);
    expect(gap).toBeLessThanOrEqual(20 * 60_000);
    expect(res.body.presence.theirs).toBeNull();

    // Bob sees it in his conversation with alice, as theirs.
    const conv = await read(b, "?with=alice");
    expect(conv.status).toBe(200);
    expect(conv.body.presence.theirs).toMatchObject({
      state: "active",
      untrusted_note: "drafting the plan",
    });
    expect(conv.body.presence.yours).toBeNull();
    // In his list of conversations.
    const list = await read(b);
    expect(list.body.conversations[0].presence).toMatchObject({
      state: "active",
    });
    // And in what's new, with a note on how to answer in kind.
    const d = await digest(b);
    expect(d.status).toBe(200);
    expect(d.body.presence).toHaveLength(1);
    expect(d.body.presence[0]).toMatchObject({
      with: "alice",
      state: "active",
      untrusted_note: "drafting the plan",
    });
    expect(d.body.presence_note).toMatch(/POST \/v1\/me\/presence/);
    expect(d.body.presence_note).toMatch(/not instructions/);
    expect(d.body.start).toBeUndefined();
    // Alice's own digest doesn't list her own presence.
    expect((await digest(a)).body.presence).toEqual([]);
  });

  it("takes an exact time, and none", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    const at = inMinutes(45);
    const res = await set(a, { with: "bob", state: "active", next_check: at });
    expect(res.status).toBe(200);
    expect(new Date(res.body.presence.yours.next_check).toISOString()).toBe(at);
    const idle = await set(a, { with: "bob", state: "idle" });
    expect(idle.status).toBe(200);
    expect(idle.body.presence.yours).toMatchObject({
      state: "idle",
      next_check: null,
      untrusted_note: null,
    });
    // Idle shows in the conversation but not in what's new.
    expect((await read(b, "?with=alice")).body.presence.theirs.state).toBe(
      "idle",
    );
    expect((await digest(b)).body.presence).toEqual([]);
  });

  it("closing shows in what's new for a day", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    await set(a, { with: "bob", state: "closing", note: "all done, thanks" });
    expect((await digest(b)).body.presence[0]).toMatchObject({
      with: "alice",
      state: "closing",
    });
    // An old closing no longer shows. Rows can't be changed, so make one
    // with an old time straight in the database.
    await db()`
      INSERT INTO presence (bot_id, other_bot_id, key_id, state, created_at)
      VALUES (${await idOf("alice")}, ${await idOf("bob")}, ${await keyIdOf("alice")},
              'closing', now() - interval '25 hours')`;
    // The newest row is by id, so that old one is now alice's presence.
    expect((await digest(b)).body.presence).toEqual([]);
  });

  it("saving the same again writes nothing and uses none of the allowance", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    const at = inMinutes(30);
    const body = { with: "bob", state: "active", next_check: at, note: "x" };
    expect((await set(a, body)).body.changed).toBe(true);
    const again = await set(a, body);
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(await rows()).toBe(1);
    const [r] = await db()<{ count: number }[]>`
      SELECT count::int FROM rate_limits WHERE bucket LIKE 'presence:%'`;
    expect(r?.count).toBe(1);
    // A different note is a change.
    expect((await set(a, { ...body, note: "y" })).body.changed).toBe(true);
    expect(await rows()).toBe(2);
  });

  it("works between contacts who have never written", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const made = await call(createCodeRoute, { key: a.key, body: {} });
    const r = await call(redeemRoute, {
      key: b.key,
      body: { code: made.body.code },
    });
    expect(r.status).toBe(200);
    // New bots, inboxes closed, no messages: contacts are enough.
    const res = await set(b, {
      with: "alice",
      state: "active",
      next_check_in_minutes: 5,
    });
    expect(res.status).toBe(200);
    expect((await digest(a)).body.presence[0].with).toBe("bob");
  });

  it("logs who told whom what state, never the note", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    await set(a, {
      with: "bob",
      state: "active",
      next_check_in_minutes: 10,
      note: "secret-ish words",
    });
    const log = await db()<{ subject: string; detail: unknown }[]>`
      SELECT subject, detail FROM action_log WHERE action = 'presence.set'`;
    expect(log).toHaveLength(1);
    expect(log[0]?.subject).toBe("bot:bob");
    expect(log[0]?.detail).toEqual({ state: "active", next_check: true });
    expect(JSON.stringify(log)).not.toMatch(/secret-ish/);
  });
});

describe("more of the edges", () => {
  it("a third bot sees neither side, even reading the conversation by handle", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const c = await bot("carol");
    await talking(a, b);
    await set(a, { with: "bob", state: "active", next_check_in_minutes: 9 });
    const r = await read(c, "?with=alice");
    expect(r.status).toBe(200);
    expect(r.body.presence).toEqual({ yours: null, theirs: null });
    expect((await digest(c)).body.presence).toEqual([]);
  });

  it("takes a time with any offset, and gives it back in UTC", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    const at = new Date(Date.now() + 30 * 60_000);
    at.setUTCSeconds(0, 0);
    // The same instant written five hours behind UTC.
    const local = new Date(at.getTime() - 5 * 3_600_000)
      .toISOString()
      .replace("Z", "-05:00");
    const res = await set(a, {
      with: "bob",
      state: "active",
      next_check: local,
    });
    expect(res.status).toBe(200);
    expect(new Date(res.body.presence.yours.next_check).getTime()).toBe(
      at.getTime(),
    );
  });

  it("the gate holds back saving the same again too", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    const body = { with: "bob", state: "idle" };
    expect((await set(a, body)).status).toBe(200);
    await setGates(
      db(),
      { message: [{ signal: "claimed", is: true }] },
      "test",
    );
    const res = await set(a, body);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_yet");
  });
});

describe("refusals", () => {
  it("a bot it hasn't talked with, itself, the house and an unknown handle", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    let res = await set(a, { with: "bob", state: "active" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("no_conversation");
    // A request alone isn't a conversation: both must have written.
    expect((await send(a, "bob", "hello")).status).toBe(201);
    res = await set(a, { with: "bob", state: "active" });
    expect(res.body.error.code).toBe("no_conversation");
    res = await set(b, { with: "alice", state: "active" });
    expect(res.body.error.code).toBe("no_conversation");
    expect((await set(a, { with: "alice", state: "idle" })).status).toBe(400);
    expect((await set(a, { with: "nobody-here", state: "idle" })).status).toBe(
      404,
    );
    await syncWelcome(db(), "Welcome.");
    res = await set(a, { with: HOUSE_HANDLE, state: "idle" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("no_conversation");
    expect(await rows()).toBe(0);
  });

  it("a block either way: the blocker is told, the blocked hears what a message would", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    await set(a, { with: "bob", state: "active", next_check_in_minutes: 15 });
    await set(b, { with: "alice", state: "active", next_check_in_minutes: 15 });
    expect((await block(a, "bob")).status).toBe(200);
    const mine = await set(a, { with: "bob", state: "idle" });
    expect(mine.status).toBe(403);
    expect(mine.body.error.code).toBe("you_blocked");
    const theirs = await set(b, { with: "alice", state: "idle" });
    expect(theirs.status).toBe(403);
    expect(theirs.body.error.code).toBe("not_accepting");
    // The same answer a message gets.
    expect((await send(b, "alice", "hi")).body.error.code).toBe(
      "not_accepting",
    );
    // The blocker doesn't see the blocked bot's presence, anywhere.
    expect((await read(a, "?with=bob")).body.presence.theirs).toBeNull();
    expect((await read(a)).body.conversations[0].presence).toBeNull();
    expect((await digest(a)).body.presence).toEqual([]);
    // The blocked bot still sees the blocker's, as it still sees its
    // messages: hiding it would tell it about the block.
    expect((await read(b, "?with=alice")).body.presence.theirs.state).toBe(
      "active",
    );
    expect((await read(b, "?with=alice")).body.messages).toHaveLength(2);
    expect((await digest(b)).body.presence[0].with).toBe("alice");
    // Your own still shows to you.
    expect((await read(a, "?with=bob")).body.presence.yours.state).toBe(
      "active",
    );
    expect(await rows()).toBe(2);
    // Unblocking: they're still in a conversation, so it works again.
    expect((await unblock(a, "bob")).status).toBe(200);
    expect((await set(b, { with: "alice", state: "idle" })).status).toBe(200);
  });

  it("a frozen bot: can't set, and its presence is hidden", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    await set(a, { with: "bob", state: "active", next_check_in_minutes: 15 });
    await setFrozen(db(), "alice", true, "test");
    expect((await set(a, { with: "bob", state: "idle" })).status).toBe(403);
    expect((await digest(b)).body.presence).toEqual([]);
    expect((await read(b, "?with=alice")).body.presence.theirs).toBeNull();
    const toFrozen = await set(b, { with: "alice", state: "active" });
    expect(toFrozen.status).toBe(403);
    expect(toFrozen.body.error.code).toBe("not_accepting");
    await setFrozen(db(), "alice", false, "test");
    expect((await digest(b)).body.presence[0].with).toBe("alice");
  });

  it("a silenced bot", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    await setSilenced(db(), "alice", 2, "test");
    const res = await set(a, { with: "bob", state: "active" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("silenced");
    expect(await rows()).toBe(0);
  });

  it("the message gate holds presence back too, saying only not yet", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    await setGates(
      db(),
      { message: [{ signal: "claimed", is: true }] },
      "test",
    );
    const res = await set(a, { with: "bob", state: "active" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_yet");
    expect(await rows()).toBe(0);
  });

  it("over the hourly limit: 429, nothing written", async () => {
    await awayFromWindowEdge(3600);
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    for (let i = 1; i <= 60; i++)
      expect(
        (
          await set(a, {
            with: "bob",
            state: "active",
            next_check_in_minutes: i,
          })
        ).status,
      ).toBe(200);
    const res = await set(a, { with: "bob", state: "idle" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(await rows()).toBe(60);
  });

  it("a closed inbox, either side, answers as a message would", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    await call(inboxRoute, { key: a.key, body: { open: false } });
    let res = await set(a, { with: "bob", state: "active" });
    expect(res.body.error.code).toBe("inbox_closed");
    res = await set(b, { with: "alice", state: "active" });
    expect(res.body.error.code).toBe("not_accepting");
    expect((await send(b, "alice", "hi")).body.error.code).toBe(
      "not_accepting",
    );
    expect(await rows()).toBe(0);
  });

  it("bad times and bad notes", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    const bad = [
      { with: "bob", state: "active", next_check: inMinutes(-10) },
      { with: "bob", state: "active", next_check: inMinutes(8 * 24 * 60) },
      { with: "bob", state: "active", next_check_in_minutes: 0 },
      { with: "bob", state: "active", next_check_in_minutes: 10081 },
      {
        with: "bob",
        state: "active",
        next_check: inMinutes(5),
        next_check_in_minutes: 5,
      },
      { with: "bob", state: "asleep" },
      { with: "bob", state: "active", next_check: "tomorrow" },
      { with: "bob", state: "active", next_check: "2026-11-07T15:20:00" },
      { with: "bob", state: "active", note: "" },
      { with: "bob", state: "active", note: "a".repeat(281) },
      { with: "bob", state: "active", note: "two\nlines" },
      { with: "bob", state: "active", note: "hidden​word" },
      { with: "bob", state: "active", note: "line sep" },
      { with: "bob", state: "active", extra: 1 },
      { state: "active" },
    ];
    for (const body of bad) {
      const res = await set(a, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // A time a minute behind is taken, for clocks a little behind.
    expect(
      (
        await set(a, {
          with: "bob",
          state: "active",
          next_check: inMinutes(-1),
        })
      ).status,
    ).toBe(200);
    expect(await rows()).toBe(1);
  });

  it("with no key, and under the kill switch", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    expect(
      (await call(presenceRoute, { body: { with: "bob", state: "idle" } }))
        .status,
    ).toBe(401);
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await set(a, { with: "bob", state: "idle" })).status).toBe(503);
    expect((await read(b, "?with=alice")).status).toBe(200);
    expect(await rows()).toBe(0);
  });
});

describe("the database backs every rule", () => {
  async function insert(from: string, to: string, extra = "") {
    return db().unsafe(
      `INSERT INTO presence (bot_id, other_bot_id, key_id, state${extra ? ", next_check" : ""})
       VALUES ($1, $2, $3, 'active'${extra ? `, ${extra}` : ""})`,
      [await idOf(from), await idOf(to), await keyIdOf(from)],
    );
  }

  it("refuses a pair that can't talk, a block, the house, a frozen bot and a bad time", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await expect(insert("alice", "bob")).rejects.toMatchObject({
      code: "UPM01",
    });
    await talking(a, b);
    await expect(insert("alice", "bob")).resolves.toBeDefined();
    await expect(
      insert("alice", "bob", "now() - interval '10 minutes'"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert("alice", "bob", "now() + interval '9 days'"),
    ).rejects.toMatchObject({ code: "23514" });
    await block(b, "alice");
    await expect(insert("alice", "bob")).rejects.toMatchObject({
      code: "UPM01",
    });
    await unblock(b, "alice");
    // Outside contacts, both inboxes must be open.
    await call(inboxRoute, { key: b.key, body: { open: false } });
    await expect(insert("alice", "bob")).rejects.toMatchObject({
      code: "UPM01",
    });
    await call(inboxRoute, { key: b.key, body: { open: true } });
    await setFrozen(db(), "bob", true, "test");
    await expect(insert("alice", "bob")).rejects.toMatchObject({
      code: "UPM01",
    });
    await setFrozen(db(), "bob", false, "test");
    await syncWelcome(db(), "Welcome.");
    await expect(insert("alice", HOUSE_HANDLE)).rejects.toMatchObject({
      code: "UPM01",
    });
  });

  it("refuses another bot's key, a silenced bot, and any change or delete", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    await expect(
      db()`
        INSERT INTO presence (bot_id, other_bot_id, key_id, state)
        VALUES (${await idOf("alice")}, ${await idOf("bob")}, ${await keyIdOf("bob")}, 'idle')`,
    ).rejects.toThrow(/own key/);
    await insert("alice", "bob");
    await expect(db()`UPDATE presence SET state = 'idle'`).rejects.toThrow();
    await expect(db()`DELETE FROM presence`).rejects.toThrow();
    await setSilenced(db(), "alice", 2, "test");
    await expect(insert("alice", "bob")).rejects.toThrow();
    expect(await rows()).toBe(1);
  });
});

describe("lapsing", () => {
  const at = (iso: string) => new Date(iso);
  const row = (
    state: "idle" | "active" | "closing",
    created: string,
    next: string | null,
  ) => ({
    id: 1,
    state,
    created_at: at(created),
    next_check: next ? at(next) : null,
    note: null,
  });

  it("grace is ten minutes, or half the gap when that's longer", () => {
    expect(graceMs(at("2026-11-07T15:00Z"), at("2026-11-07T15:05Z"))).toBe(
      GRACE_MIN_MINUTES * 60_000,
    );
    expect(graceMs(at("2026-11-07T15:00Z"), at("2026-11-07T17:00Z"))).toBe(
      60 * 60_000,
    );
    // A next_check before it was set gives the floor.
    expect(graceMs(at("2026-11-07T15:00Z"), at("2026-11-07T14:59Z"))).toBe(
      GRACE_MIN_MINUTES * 60_000,
    );
  });

  it("active lapses to idle past next_check plus grace, and not before", () => {
    const r = row("active", "2026-11-07T15:00Z", "2026-11-07T15:20Z");
    expect(toPresence(r, at("2026-11-07T15:29Z")).lapsed).toBe(false);
    const late = toPresence(r, at("2026-11-07T15:31Z"));
    expect(late).toMatchObject({
      state: "active",
      effective_state: "idle",
      lapsed: true,
    });
    const long = row("active", "2026-11-07T15:00Z", "2026-11-07T17:00Z");
    expect(toPresence(long, at("2026-11-07T17:59Z")).lapsed).toBe(false);
    expect(toPresence(long, at("2026-11-07T18:01Z")).lapsed).toBe(true);
  });

  it("active with no next_check lapses an hour after it was set; idle and closing never do", () => {
    const r = row("active", "2026-11-07T15:00Z", null);
    expect(toPresence(r, at("2026-11-07T15:59Z")).lapsed).toBe(false);
    expect(ACTIVE_UNTIMED_MINUTES).toBe(60);
    expect(toPresence(r, at("2026-11-07T16:01Z")).lapsed).toBe(true);
    for (const s of ["idle", "closing"] as const) {
      const p = toPresence(
        row(s, "2026-11-07T15:00Z", "2026-11-07T15:05Z"),
        at("2026-11-09T00:00Z"),
      );
      expect(p.lapsed).toBe(false);
      expect(p.effective_state).toBe(s);
    }
  });

  it("a lapsed active leaves what's new but stays in the conversation", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await talking(a, b);
    await db()`
      INSERT INTO presence (bot_id, other_bot_id, key_id, state, created_at)
      VALUES (${await idOf("alice")}, ${await idOf("bob")}, ${await keyIdOf("alice")},
              'active', now() - interval '2 hours')`;
    expect((await digest(b)).body.presence).toEqual([]);
    expect((await read(b, "?with=alice")).body.presence.theirs).toMatchObject({
      state: "active",
      effective_state: "idle",
      lapsed: true,
    });
  });
});

describe("the connector", () => {
  let rpcId = 0;
  async function rpc(key: string, method: string, params: object = {}) {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
    });
    const res = await mcpRoute(req, undefined as never);
    return (await res.json()).result;
  }
  async function tool(key: string, name: string, args: object) {
    const result = await rpc(key, "tools/call", { name, arguments: args });
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

  it("sets presence with the same checks, and reads it back the same", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const refused = await tool(a.key, "set_presence", {
      with: "bob",
      state: "active",
    });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe("no_conversation");
    await talking(a, b);
    const r = await tool(a.key, "set_presence", {
      with: "bob",
      state: "active",
      next_check_in_minutes: 10,
      note: "on it",
    });
    expect(r.isError).toBe(false);
    expect(r.data.presence.yours.state).toBe("active");
    const d = await tool(b.key, "read_digest", {});
    expect(d.data.presence[0]).toMatchObject({ with: "alice" });
    expect(d.data.presence_note).toMatch(/set_presence/);
    expect(d.data.presence_note).not.toMatch(/\/v1\//);
    const conv = await tool(b.key, "read_messages", { with: "alice" });
    expect(conv.data.presence.theirs.untrusted_note).toBe("on it");
  });

  it("tells a bot to keep its owner out of the note, and the guide says the same", async () => {
    const a = await bot("alice");
    const tools = (await rpc(a.key, "tools/list")).tools as {
      name: string;
      description: string;
    }[];
    const about = tools.find((t) => t.name === "set_presence")?.description;
    expect(about).toMatch(/never put anything about the person you work for/);
    expect(about).toMatch(/10 minutes or half the gap/);
    const skill = readFileSync("content/skill.md", "utf8");
    expect(skill).toContain("POST {{BASE_URL}}/v1/me/presence");
    expect(skill).toMatch(
      /Never put anything about the person you work for in it/,
    );
    expect(skill).toMatch(/60 presence changes an hour per bot/);
    expect(readFileSync("content/mcp.md", "utf8")).toMatch(/set_presence/);
    expect(JSON.stringify(OPERATIONS)).toMatch(/\/v1\/me\/presence/);
  });
});
