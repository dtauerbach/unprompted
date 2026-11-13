import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  POST as blockRoute,
  DELETE as unblockRoute,
} from "@/app/v1/bots/[handle]/block/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as commsRoute } from "@/app/v1/me/comms/route";
import { DELETE as removeContactRoute } from "@/app/v1/me/contacts/[handle]/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as createCodeRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as presenceRoute } from "@/app/v1/me/presence/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { GET as readRoute, POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import {
  setAntiAbuse,
  setFrozen,
  setGates,
  setPrivateChannelHidden,
  setSilenced,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { OPERATIONS } from "@/lib/openapi";
import {
  ACTIVE_UNTIMED_MINUTES,
  GRACE_MIN_MINUTES,
  graceMs,
  toPresence,
} from "@/lib/presence";
import { setOwnBots, startChannel } from "@/lib/private-channels";
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

  it("a block between contacts who never wrote: the blocked bot still sees the blocker's", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const made = await call(createCodeRoute, { key: a.key, body: {} });
    await call(redeemRoute, { key: b.key, body: { code: made.body.code } });
    await set(a, { with: "bob", state: "active", next_check_in_minutes: 15 });
    await set(b, { with: "alice", state: "active", next_check_in_minutes: 15 });
    // The block ends the contact, so the two can no longer talk, but a row
    // set under the pair rules reads as it always has.
    expect((await block(a, "bob")).status).toBe(200);
    expect((await read(b, "?with=alice")).body.presence.theirs.state).toBe(
      "active",
    );
    expect((await digest(b)).body.presence[0].with).toBe("alice");
    expect((await read(a, "?with=bob")).body.presence.theirs).toBeNull();
    expect((await read(a, "?with=bob")).body.presence.yours.state).toBe(
      "active",
    );
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

// A session is set by a group's leader alone, so another member tells the
// group when it'll be back with presence. A live trial found it refused
// between members with closed inboxes that never wrote one to one. With a
// shared visible group, presence takes a group message's refusals and none
// of a pair's; without one, the pair rules above hold unchanged.
describe("between members of one group", () => {
  // A bot past its first day, its inbox left closed.
  async function member(handle: string) {
    const b = await register(handle);
    await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
    return b;
  }

  async function owner(authId: string, bots: Bot[]) {
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES (${authId})
      ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
      RETURNING id`;
    for (const b of bots)
      await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${b.handle}`;
  }

  const group = async (bots: Bot[]) =>
    (
      await startChannel(
        db(),
        "google-g",
        bots.map((b) => b.handle),
        bots[0]?.handle,
        null,
      )
    ).channel;

  // Three bots of one person in one group that ann leads.
  async function trio() {
    const ann = await member("ann");
    const ben = await member("ben");
    const cyd = await member("cyd");
    await owner("google-g", [ann, ben, cyd]);
    return { ann, ben, cyd, g: await group([ann, ben, cyd]) };
  }

  const wake = async (b: Bot): Promise<number> =>
    (await call(wakeRoute, { key: b.key })).body.wake;
  const toGroup = (b: Bot, g: string, body: string) =>
    call(sendRoute, { key: b.key, body: { channel: g, body } });
  async function used(like: string): Promise<number> {
    const [r] = await db()<{ n: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
      WHERE bucket LIKE ${like}`;
    return r?.n ?? 0;
  }
  const wakesUsed = async () => ({
    person: await used("channel-wake:person:%"),
    all: await used("channel-wake:all"),
  });

  it("lets a member that isn't the leader tell another when it'll be back, inboxes closed, and it shows in what's new", async () => {
    const { ann, ben } = await trio();
    const before = await wake(ann);
    const caps = await wakesUsed();
    const r = await set(ben, {
      with: "ann",
      state: "active",
      next_check_in_minutes: 90,
      note: "back after the draft",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.presence.yours.state).toBe("active");
    expect(await wake(ann)).toBe(before + 1);
    const d = await digest(ann);
    expect(d.body.presence).toEqual([
      expect.objectContaining({
        with: "ben",
        state: "active",
        untrusted_note: "back after the draft",
      }),
    ]);
    // One presence and one group wake, against the person's share and the
    // site-wide cap.
    expect(await used("presence:%")).toBe(1);
    expect(await wakesUsed()).toEqual({
      person: caps.person + 1,
      all: caps.all + 1,
    });
    // Saving the same again writes nothing and counts nothing.
    const again = await set(ben, {
      with: "ann",
      state: "active",
      next_check: r.body.presence.yours.next_check,
      note: "back after the draft",
    });
    expect(again.body.changed).toBe(false);
    expect(await wakesUsed()).toEqual({
      person: caps.person + 1,
      all: caps.all + 1,
    });
  });

  it("leaves the pair rules unchanged for a bot outside the group, writing nothing", async () => {
    const { ben } = await trio();
    const out = await member("out");
    const toMember = await set(out, { with: "ben", state: "active" });
    expect(toMember.status).toBe(403);
    expect(toMember.body.error.code).toBe(
      (await send(out, "ben", "hello?")).body.error.code,
    );
    const fromMember = await set(ben, { with: "out", state: "active" });
    expect(fromMember.status).toBe(403);
    expect(fromMember.body.error.code).toBe("inbox_closed");
    await call(inboxRoute, { key: out.key, body: { open: true } });
    const open = await set(out, { with: "ben", state: "active" });
    expect(open.status).toBe(403);
    expect(open.body.error.code).toBe("no_conversation");
    expect(await rows()).toBe(0);
  });

  it("ends when a bot is taken out: the pair rules hold again, and what was set stops showing", async () => {
    const { ann, ben, cyd, g } = await trio();
    expect((await set(ben, { with: "ann", state: "active" })).status).toBe(200);
    expect((await set(ann, { with: "ben", state: "active" })).status).toBe(200);
    expect((await digest(ann)).body.presence).toHaveLength(1);
    await setOwnBots(db(), "google-g", g, [], [ben.handle], null);
    const n = await rows();
    const out = await set(ben, { with: "ann", state: "idle" });
    expect(out.status).toBe(403);
    expect(out.body.error.code).toBe(
      (await send(ben, "ann", "still there?")).body.error.code,
    );
    const back = await set(ann, { with: "ben", state: "idle" });
    expect(back.status).toBe(403);
    expect(await rows()).toBe(n);
    expect((await digest(ann)).body.presence).toEqual([]);
    expect((await digest(ben)).body.presence).toEqual([]);
    // The two still in it go on.
    expect((await set(cyd, { with: "ann", state: "idle" })).status).toBe(200);
  });

  it("ends when a moderator hides the group", async () => {
    const { ann, ben, g } = await trio();
    expect((await set(ben, { with: "ann", state: "active" })).status).toBe(200);
    await setPrivateChannelHidden(db(), Number(g.slice(8)), true, "Test.");
    const after = await set(ben, { with: "ann", state: "idle" });
    expect(after.status).toBe(403);
    expect((await digest(ann)).body.presence).toEqual([]);
    // Unhidden, it shows again.
    await setPrivateChannelHidden(db(), Number(g.slice(8)), false, "Test.");
    expect((await digest(ann)).body.presence).toHaveLength(1);
  });

  // A closed group takes nothing new (058_closed_sessions.sql): presence
  // between members that rode on it is refused as a message there is, and
  // what was set stops showing.
  const close = (b: Bot, g: string) =>
    call(closeRoute, { key: b.key, params: { id: g.slice(8) } });

  it("ends when the group closes: refused as closed, writing and waking nothing, and what was set stops showing", async () => {
    const { ann, ben, g } = await trio();
    expect((await set(ben, { with: "ann", state: "active" })).status).toBe(200);
    expect((await digest(ann)).body.presence).toHaveLength(1);
    const closed = await close(ann, g);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const n = await rows();
    const before = await wake(ann);
    const caps = await wakesUsed();
    const after = await set(ben, { with: "ann", state: "idle" });
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe("channel_closed");
    // The same refusal a message there gets.
    expect(after.body.error).toEqual(
      (await toGroup(ben, g, "still there?")).body.error,
    );
    // Either way round, and a new state too.
    const back = await set(ann, { with: "ben", state: "closing" });
    expect(back.body.error.code).toBe("channel_closed");
    expect(await rows()).toBe(n);
    expect(await wake(ann)).toBe(before);
    expect(await wakesUsed()).toEqual(caps);
    expect(await used("presence:%")).toBe(1);
    expect((await digest(ann)).body.presence).toEqual([]);
    expect((await digest(ben)).body.presence).toEqual([]);
  });

  it("goes on under the pair rules after a close, for two bots that can talk anyway", async () => {
    const ann = await member("ann");
    const ben = await member("ben");
    await owner("google-g", [ann, ben]);
    const made = await call(createCodeRoute, { key: ann.key, body: {} });
    await call(redeemRoute, { key: ben.key, body: { code: made.body.code } });
    const g = await group([ann, ben]);
    expect((await close(ann, g)).status).toBe(200);
    const r = await set(ben, { with: "ann", state: "active" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [row] = await db()<{ channel_id: string | null }[]>`
      SELECT channel_id FROM presence ORDER BY id DESC LIMIT 1`;
    expect(row?.channel_id).toBeNull();
    expect((await digest(ann)).body.presence).toHaveLength(1);
  });

  it("still rides on another shared group that's open", async () => {
    const { ann, ben, g } = await trio();
    const g2 = await group([ann, ben]);
    expect((await close(ann, g)).status).toBe(200);
    expect((await set(ben, { with: "ann", state: "active" })).status).toBe(200);
    const [row] = await db()<{ channel_id: string | null }[]>`
      SELECT channel_id FROM presence ORDER BY id DESC LIMIT 1`;
    expect(`private:${row?.channel_id}`).toBe(g2);
    expect((await digest(ann)).body.presence).toHaveLength(1);
  });

  it("is refused by the database between members of a closed group only, whatever the writer gives, and goes in with an open one", async () => {
    const { ann, ben, g } = await trio();
    expect((await close(ann, g)).status).toBe(200);
    const [k] = await db()<{ id: string }[]>`
      SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
      WHERE b.handle = 'ben' AND k.revoked_at IS NULL`;
    const err = await db()`
      INSERT INTO presence (bot_id, other_bot_id, key_id, state, channel_id)
      VALUES (${await idOf("ben")}, ${await idOf("ann")}, ${k?.id ?? null},
              'active', ${g.slice(8)})`.catch((e) => e);
    expect(err.code).toBe("UPM01");
    expect(await rows()).toBe(0);
    // The contrast: with a group still open, the same row goes in, riding
    // on that group whatever the writer named.
    const g2 = await group([ann, ben]);
    await db()`
      INSERT INTO presence (bot_id, other_bot_id, key_id, state, channel_id)
      VALUES (${await idOf("ben")}, ${await idOf("ann")}, ${k?.id ?? null},
              'active', ${g.slice(8)})`;
    const [row] = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM presence`;
    expect(`private:${row?.channel_id}`).toBe(g2);
  });

  // The lowest shared group is the one a write rides on and whose lock it
  // takes. If that group closes while the write waits for its lock, and
  // another shared group is left, the write starts again and takes that
  // group's lock: it never rides on a group whose lock it doesn't hold.
  it("starts again when the group it waited on closes and another is left", async () => {
    const { ann, ben, g } = await trio();
    const g2 = await group([ann, ben]);
    const [k] = await db()<{ id: string }[]>`
      SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
      WHERE b.handle = 'ann' AND k.revoked_at IS NULL`;
    const gate = () => {
      let open = () => {};
      const shut = new Promise<void>((r) => {
        open = r;
      });
      return { shut, open };
    };
    const waiting = async () => {
      for (let i = 0; i < 100; i++) {
        const [r] = await db()<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted`;
        if ((r?.n ?? 0) > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("nothing waited for a lock");
    };
    const heldA = gate();
    const goA = gate();
    const heldB = gate();
    const goB = gate();
    // One transaction holds the first group's lock, then closes it; another
    // holds the second group's.
    const a = db().begin(async (tx) => {
      await tx`SELECT lock_private_channel(${g.slice(8)})`;
      heldA.open();
      await goA.shut;
      await tx`
        INSERT INTO channel_ends (channel_id, how, bot_id, key_id)
        VALUES (${g.slice(8)}, 'closed', ${await idOf("ann")}, ${k?.id ?? null})`;
    });
    const b = db().begin(async (tx) => {
      await tx`SELECT lock_private_channel(${g2.slice(8)})`;
      heldB.open();
      await goB.shut;
    });
    await heldA.shut;
    await heldB.shut;
    const r = set(ben, { with: "ann", state: "active" });
    await waiting();
    goA.open();
    await a;
    // Started again on the second group, it waits for that group's lock.
    await waiting();
    expect(await rows()).toBe(0);
    goB.open();
    await b;
    const done = await r;
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const [row] = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM presence`;
    expect(`private:${row?.channel_id}`).toBe(g2);
    expect(await rows()).toBe(1);
  }, 30_000);

  it("racing a close, either goes in before it or is refused as closed, and never shows after", async () => {
    for (let round = 0; round < 4; round++) {
      await resetDb();
      const { ann, ben, g } = await trio();
      const [r, c] = await Promise.all([
        set(ben, { with: "ann", state: "active" }),
        close(ann, g),
      ]);
      expect(c.status).toBe(200);
      expect([200, 409], JSON.stringify(r.body)).toContain(r.status);
      if (r.status === 409) expect(r.body.error.code).toBe("channel_closed");
      expect((await digest(ann)).body.presence).toEqual([]);
    }
  }, 60_000);

  it("rides on any shared group, counting one wake, and ends only when none is left", async () => {
    const { ann, ben, cyd, g } = await trio();
    const g2 = await group([ann, ben]);
    const caps = await wakesUsed();
    expect((await set(ben, { with: "ann", state: "active" })).status).toBe(200);
    expect(await wakesUsed()).toEqual({
      person: caps.person + 1,
      all: caps.all + 1,
    });
    // Hide the lower one, then take ben out of the other: gone only then.
    await setPrivateChannelHidden(db(), Number(g.slice(8)), true, "Test.");
    expect((await digest(ann)).body.presence).toHaveLength(1);
    expect((await set(ben, { with: "ann", state: "idle" })).status).toBe(200);
    await setOwnBots(db(), "google-g", g2, [], [ben.handle], null);
    expect((await digest(ann)).body.presence).toEqual([]);
    expect((await set(ben, { with: "ann", state: "active" })).status).toBe(403);
    expect(cyd.handle).toBe("cyd");
  });

  it("names the group it rode on itself, and a hidden one never brings an older pair row back", async () => {
    const ann = await member("ann");
    const ben = await member("ben");
    await owner("google-g", [ann, ben]);
    const made = await call(createCodeRoute, { key: ann.key, body: {} });
    await call(redeemRoute, { key: ben.key, body: { code: made.body.code } });
    // Contacts first: a row under the pair rules, with no group.
    expect((await set(ben, { with: "ann", state: "closing" })).status).toBe(
      200,
    );
    const g = await group([ann, ben]);
    expect((await set(ben, { with: "ann", state: "active" })).status).toBe(200);
    const kept = await db()<{ channel_id: string | null }[]>`
      SELECT channel_id FROM presence ORDER BY id`;
    expect(kept.map((r) => r.channel_id)).toEqual([null, g.slice(8)]);
    // The writer can't name another group, or none.
    await db()`
      INSERT INTO presence (bot_id, other_bot_id, key_id, state, channel_id)
      VALUES (${await idOf("ben")}, ${await idOf("ann")}, ${await keyIdOf("ben")}, 'active', NULL)`;
    const [last] = await db()<{ channel_id: string | null }[]>`
      SELECT channel_id FROM presence ORDER BY id DESC LIMIT 1`;
    expect(last?.channel_id).toBe(g.slice(8));
    // No longer contacts, and out of the group: the newest row is hidden,
    // and the older closing doesn't come back in its place.
    expect(
      (
        await call(removeContactRoute, {
          key: ann.key,
          method: "DELETE",
          params: { handle: "ben" },
        })
      ).status,
    ).toBe(200);
    await setOwnBots(db(), "google-g", g, [], [ben.handle], null);
    expect((await digest(ann)).body.presence).toEqual([]);
    expect((await read(ann, "?with=ben")).body.presence.theirs).toBeNull();
  });

  it("a block refuses nothing either way and tells nothing: the blocker isn't woken and sees nothing", async () => {
    const { ann, ben, g } = await trio();
    expect((await block(ann, "ben")).status).toBe(200);
    // ann's own block, as a group message from ann would be: taken, and ben
    // sees it and is woken.
    const benWake = await wake(ben);
    const mine = await set(ann, { with: "ben", state: "active" });
    expect(mine.status).toBe(200);
    expect(await wake(ben)).toBe(benWake + 1);
    expect((await digest(ben)).body.presence).toHaveLength(1);
    // ben, blocked: the same answer and the same counts as toward cyd,
    // whom nobody blocked. Presence always counts one wake, landed or not,
    // where a group message counts only the wakes that land; so a block
    // shows in neither.
    const annWake = await wake(ann);
    const c0 = await wakesUsed();
    const blocked = await set(ben, {
      with: "ann",
      state: "active",
      note: "back soon",
    });
    const c1 = await wakesUsed();
    const free = await set(ben, { with: "cyd", state: "active" });
    const c2 = await wakesUsed();
    expect([blocked.status, free.status]).toEqual([200, 200]);
    expect(Object.keys(blocked.body).sort()).toEqual(
      Object.keys(free.body).sort(),
    );
    expect(blocked.body.changed).toBe(true);
    expect(c1.person - c0.person).toBe(c2.person - c1.person);
    expect(c1.all - c0.all).toBe(c2.all - c1.all);
    expect((await toGroup(ben, g, "back soon")).status).toBe(201);
    expect(await wake(ann)).toBe(annWake);
    expect((await digest(ann)).body.presence).toEqual([]);
    // Unblocked, ben's newest shows, as its messages would.
    await unblock(ann, "ben");
    expect((await digest(ann)).body.presence).toEqual([
      expect.objectContaining({ with: "ben", untrusted_note: "back soon" }),
    ]);
  });

  it("a full share refuses alike, blocked or not, so the cap can't tell a block", async () => {
    const { ann, ben } = await trio();
    await block(ann, "ben");
    const c = await wakesUsed();
    await setAntiAbuse(db(), { group_wake_person: c.person + 1 }, "Test.");
    const last = await set(ben, { with: "cyd", state: "active" });
    expect(last.status).toBe(200);
    const toBlocker = await set(ben, { with: "ann", state: "active" });
    const toFree = await set(ben, { with: "cyd", state: "idle" });
    expect([toBlocker.status, toFree.status]).toEqual([429, 429]);
    expect(toBlocker.body.error.code).toBe(toFree.body.error.code);
    // The wait in each message can differ by a second between two calls.
    const plain = (m: string) => m.replace(/\d+ seconds?/, "N seconds");
    expect(plain(toBlocker.body.error.message)).toBe(
      plain(toFree.body.error.message),
    );
    expect(toBlocker.body.error.message).toMatch(/Try again in \d+ seconds?/);
    expect(ann.handle).toBe("ann");
  });

  it("holds the sender to its own comms rules, as a group message, and never the recipient's", async () => {
    const { ann, ben, g } = await trio();
    const onlyPublic = { accepts: ["public"] };
    expect(
      (await call(commsRoute, { key: ann.key, body: onlyPublic })).status,
    ).toBe(200);
    // The recipient's rules don't refuse it.
    expect((await set(ben, { with: "ann", state: "active" })).status).toBe(200);
    // The sender's do, in a group message's words, writing nothing.
    const n = await rows();
    const mine = await set(ann, { with: "ben", state: "active" });
    const message = await toGroup(ann, g, "hello");
    expect(mine.status).toBe(403);
    expect(mine.body.error).toEqual(message.body.error);
    expect(mine.body.error.code).toBe("comms_rules");
    expect(await rows()).toBe(n);
    // The database backs it.
    await expect(
      db()`
        INSERT INTO presence (bot_id, other_bot_id, key_id, state)
        VALUES (${await idOf("ann")}, ${await idOf("ben")}, ${await keyIdOf("ann")}, 'active')`,
    ).rejects.toMatchObject({ code: "UPM01" });
  });

  it("an inbox, open or closed, changes nothing between members", async () => {
    const { ann, ben } = await trio();
    const closed = await set(ben, { with: "ann", state: "idle" });
    await call(inboxRoute, { key: ann.key, body: { open: true } });
    await call(inboxRoute, { key: ben.key, body: { open: true } });
    const open = await set(ben, { with: "ann", state: "active" });
    expect([closed.status, open.status]).toEqual([200, 200]);
    expect(Object.keys(closed.body).sort()).toEqual(
      Object.keys(open.body).sort(),
    );
  });

  it("a frozen member is told without a refusal, isn't woken, and its own is hidden; a silenced setter and the gate refuse", async () => {
    const { ann, ben, cyd } = await trio();
    expect((await set(cyd, { with: "ann", state: "active" })).status).toBe(200);
    await setFrozen(db(), "cyd", true, "test");
    const [w] = await db()<{ n: number }[]>`
      SELECT coalesce((SELECT count FROM wake_counters WHERE bot_id = ${await idOf("cyd")}), 0)::int AS n`;
    const toFrozen = await set(ben, { with: "cyd", state: "active" });
    expect(toFrozen.status).toBe(200);
    const [w2] = await db()<{ n: number }[]>`
      SELECT coalesce((SELECT count FROM wake_counters WHERE bot_id = ${await idOf("cyd")}), 0)::int AS n`;
    expect(w2?.n).toBe(w?.n);
    expect((await digest(ann)).body.presence).toEqual([]);
    await setSilenced(db(), "ben", 2, "test");
    const silenced = await set(ben, { with: "ann", state: "active" });
    expect(silenced.body.error.code).toBe("silenced");
    const n = await rows();
    await setGates(db(), { message: [{ signal: "claimed", is: false }] }, "t");
    const gated = await set(ann, { with: "ben", state: "active" });
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe("not_yet");
    expect(await rows()).toBe(n);
  });

  it("is backed by the database: members may whatever a block or a freeze, a bot taken out may not", async () => {
    const { ann, ben, g } = await trio();
    const insert = async (from: string, to: string) =>
      db()`
        INSERT INTO presence (bot_id, other_bot_id, key_id, state)
        VALUES (${await idOf(from)}, ${await idOf(to)}, ${await keyIdOf(from)}, 'active')`;
    await expect(insert("ben", "ann")).resolves.toBeDefined();
    const annWake = await wake(ann);
    await block(ann, "ben");
    await expect(insert("ann", "ben")).resolves.toBeDefined();
    await expect(insert("ben", "ann")).resolves.toBeDefined();
    expect(await wake(ann)).toBe(annWake);
    await setFrozen(db(), "cyd", true, "test");
    await expect(insert("ben", "cyd")).resolves.toBeDefined();
    await setFrozen(db(), "cyd", false, "test");
    await unblock(ann, "ben");
    await setOwnBots(db(), "google-g", g, [], [ben.handle], null);
    await expect(insert("ben", "ann")).rejects.toMatchObject({
      code: "UPM01",
    });
    await expect(insert("ann", "ben")).rejects.toMatchObject({
      code: "UPM01",
    });
    await expect(insert("cyd", "ann")).resolves.toBeDefined();
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
    expect(d.data.presence_note).toMatch(/set_event/);
    expect(d.data.presence_note).not.toMatch(/\/v1\//);
    const conv = await tool(b.key, "read_channel", { with: "alice" });
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
    // How it lapses is the guide's to say; the tool says each call replaces
    // the whole of it.
    expect(about).toMatch(/Each call replaces the whole presence/);
    expect(about).toMatch(/another member of a private channel/);
    const skill = readFileSync("content/skill.md", "utf8");
    expect(skill).toContain("`POST /v1/me/presence`");
    expect(skill).toMatch(/never about the person you work for/);
    expect(skill).toMatch(/10 minutes or half the gap/);
    expect(skill).toMatch(/a member of a private channel you're in/);
    expect(skill).toMatch(/60 presence changes an hour per bot/);
    expect(readFileSync("content/mcp.md", "utf8")).toMatch(/set_presence/);
    expect(JSON.stringify(OPERATIONS)).toMatch(/\/v1\/me\/presence/);
  });
});
