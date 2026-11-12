import { beforeEach, describe, expect, it } from "vitest";
import {
  POST as blockRoute,
  DELETE as unblockRoute,
} from "@/app/v1/bots/[handle]/block/route";
import { DELETE as removeRoute } from "@/app/v1/me/contacts/[handle]/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as createRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { call, register, resetDb } from "./helpers";

// Pairs as private channels of two (047_private_channels.sql): each pair
// with a message or a contact has one channel, its two bots its members, and
// every message from now on names it. Nothing a bot sees changes
// (pair-golden.test.ts); these hold the tables themselves.

beforeEach(resetDb);

type Bot = { handle: string; key: string };

async function bot(handle: string, open = true): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  if (open) await call(inboxRoute, { key: b.key, body: { open: true } });
  return b;
}
const send = (from: Bot, to: string, body: string) =>
  call(sendRoute, { key: from.key, body: { to, body } });
const pair = async (a: Bot, b: Bot) => {
  const made = await call(createRoute, { key: a.key, body: {} });
  return call(redeemRoute, { key: b.key, body: { code: made.body.code } });
};

async function keyOf(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
    WHERE b.handle = ${handle} AND k.revoked_at IS NULL`;
  return Number(r?.id);
}

// Writes as the tables were before private channels: the channel triggers
// and the check off for the length of fn.
async function beforeChannels(fn: () => Promise<void>): Promise<void> {
  await db()`ALTER TABLE messages DISABLE TRIGGER messages_zz_set_channel`;
  await db()`ALTER TABLE contacts DISABLE TRIGGER contacts_set_channel`;
  await db()`ALTER TABLE messages DROP CONSTRAINT messages_have_channel`;
  try {
    await fn();
  } finally {
    await db()`ALTER TABLE messages ENABLE TRIGGER messages_zz_set_channel`;
    await db()`ALTER TABLE contacts ENABLE TRIGGER contacts_set_channel`;
    await db()`ALTER TABLE messages ADD CONSTRAINT messages_have_channel
               CHECK (channel_id IS NOT NULL) NOT VALID`;
  }
}

async function idOf(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

// The pair's channel and its members, as the tables hold them.
async function channelOf(x: string, y: string) {
  const [a, b] = [await idOf(x), await idOf(y)];
  const [d] = await db()<{ channel_id: string }[]>`
    SELECT channel_id FROM direct_channels
    WHERE bot_low = ${Math.min(a, b)} AND bot_high = ${Math.max(a, b)}`;
  if (!d) return undefined;
  const members = await db()<{ handle: string; via: string; from: string }[]>`
    SELECT b.handle, m.via, m.from_message_id::text AS from
    FROM channel_members m JOIN bots b ON b.id = m.bot_id
    WHERE m.channel_id = ${d.channel_id} AND channel_has(m.channel_id, m.bot_id)
    ORDER BY b.handle`;
  return { id: Number(d.channel_id), members };
}

async function counts() {
  const [r] = await db()<
    { channels: number; members: number; direct: number; messages: number }[]
  >`
    SELECT (SELECT count(*) FROM private_channels)::int AS channels,
           (SELECT count(*) FROM channel_members)::int AS members,
           (SELECT count(*) FROM direct_channels)::int AS direct,
           (SELECT count(*) FROM messages)::int AS messages`;
  if (!r) throw new Error("no counts");
  return r;
}

describe("a pair's private channel", () => {
  it("is made with the pair's first message, and every message after goes to it", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    expect(await channelOf("alice", "bob")).toBeUndefined();
    expect((await send(a, "bob", "hello")).status).toBe(201);
    const c = await channelOf("alice", "bob");
    expect(c?.members).toEqual([
      { handle: "alice", via: "message", from: "0" },
      { handle: "bob", via: "message", from: "0" },
    ]);
    expect((await send(b, "alice", "hi")).status).toBe(201);
    expect((await send(b, "alice", "again")).status).toBe(201);
    const rows = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM messages ORDER BY id`;
    expect(rows.map((r) => Number(r.channel_id))).toEqual([
      c?.id,
      c?.id,
      c?.id,
    ]);
    expect(await counts()).toEqual({
      channels: 1,
      members: 2,
      direct: 1,
      messages: 3,
    });
  });

  it("is one per pair, whoever writes first", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const c = await bot("carol");
    await send(a, "bob", "1");
    await send(c, "alice", "2");
    await send(b, "carol", "3");
    await send(b, "alice", "4");
    const ab = await channelOf("alice", "bob");
    const ac = await channelOf("carol", "alice");
    const bc = await channelOf("bob", "carol");
    expect(new Set([ab?.id, ac?.id, bc?.id]).size).toBe(3);
    expect((await counts()).channels).toBe(3);
    const rows = await db()<{ channel_id: string; body: string }[]>`
      SELECT channel_id, body FROM messages ORDER BY id`;
    expect(rows.map((r) => [r.body, Number(r.channel_id)])).toEqual([
      ["1", ab?.id],
      ["2", ac?.id],
      ["3", bc?.id],
      ["4", ab?.id],
    ]);
  });

  it("is made when two bots pair, before any message", async () => {
    const a = await bot("alice", false);
    const b = await bot("bob", false);
    const made = await call(createRoute, { key: a.key, body: {} });
    expect(
      (await call(redeemRoute, { key: b.key, body: { code: made.body.code } }))
        .status,
    ).toBe(200);
    const c = await channelOf("alice", "bob");
    expect(c?.members.map((m) => m.via)).toEqual(["code", "code"]);
    expect((await send(b, "alice", "paired")).status).toBe(201);
    const [m] = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM messages`;
    expect(Number(m?.channel_id)).toBe(c?.id);
    expect((await counts()).channels).toBe(1);
  });

  it("isn't made by a message every rule refuses", async () => {
    const a = await bot("alice");
    await bot("bob", false);
    const c = await bot("carol");
    const eve = await register("eve");
    await call(inboxRoute, { key: eve.key, body: { open: true } });
    // Bob's inbox is closed; Carol blocked Alice; Eve is new.
    expect((await send(a, "bob", "hello")).status).toBeGreaterThanOrEqual(400);
    expect(
      (await call(blockRoute, { key: c.key, params: { handle: "alice" } }))
        .status,
    ).toBeLessThan(300);
    expect((await send(a, "carol", "hello")).status).toBeGreaterThanOrEqual(
      400,
    );
    expect((await send(eve, "alice", "hi")).status).toBeGreaterThanOrEqual(400);
    expect(await counts()).toEqual({
      channels: 0,
      members: 0,
      direct: 0,
      messages: 0,
    });
  });

  it("can't be chosen by whoever writes a message", async () => {
    const a = await bot("alice");
    await bot("bob");
    const c = await bot("carol");
    await send(a, "bob", "hello");
    await send(c, "alice", "hi");
    const other = await channelOf("carol", "alice");
    const [ids] = await db()<{ a: string; b: string; k: string }[]>`
      SELECT (SELECT id FROM bots WHERE handle = 'bob') AS a,
             (SELECT id FROM bots WHERE handle = 'alice') AS b,
             (SELECT id FROM api_keys WHERE bot_id = (SELECT id FROM bots WHERE handle = 'bob')) AS k`;
    await expect(
      db()`INSERT INTO messages (bot_id, to_bot_id, key_id, body, channel_id)
           VALUES (${ids?.a ?? null}, ${ids?.b ?? null}, ${ids?.k ?? null},
                   'sideways', ${other?.id ?? null})`,
    ).rejects.toMatchObject({ code: "UPR01" });
  });

  it("keeps its tables append-only", async () => {
    const a = await bot("alice");
    await bot("bob");
    await send(a, "bob", "hello");
    for (const t of [
      "private_channels",
      "channel_members",
      "direct_channels",
    ]) {
      await expect(db().unsafe(`DELETE FROM ${t}`)).rejects.toThrow();
      await expect(
        db().unsafe(`UPDATE ${t} SET created_at = now()`),
      ).rejects.toThrow();
    }
    await expect(db()`UPDATE messages SET channel_id = NULL`).rejects.toThrow();
  });
});

describe("a pair's private channel, under load and at the edges", () => {
  it("is made once when the pair's first two messages cross", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const a = await bot("alice");
      const b = await bot("bob");
      const [x, y] = await Promise.all([
        send(a, "bob", "from alice"),
        send(b, "alice", "from bob"),
      ]);
      expect([x.status, y.status]).toEqual([201, 201]);
      expect(await counts()).toEqual({
        channels: 1,
        members: 2,
        direct: 1,
        messages: 2,
      });
    }
  });

  it("is made once when a first message races a pairing", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const a = await bot("alice");
      const b = await bot("bob");
      const made = await call(createRoute, { key: a.key, body: {} });
      const [x, y] = await Promise.all([
        send(a, "bob", "hello"),
        call(redeemRoute, { key: b.key, body: { code: made.body.code } }),
      ]);
      expect(x.status).toBe(201);
      expect(y.status).toBe(200);
      const c = await counts();
      expect([c.channels, c.members, c.direct]).toEqual([1, 2, 1]);
    }
  });

  it("isn't made by a message the database itself refuses", async () => {
    const a = await bot("alice");
    await bot("bob", false);
    const c = await bot("carol");
    // Straight into the table, past the app: Bob's inbox is closed.
    await expect(
      db()`INSERT INTO messages (bot_id, to_bot_id, key_id, body)
           VALUES (${await idOf("alice")}, ${await idOf("bob")},
                   ${await keyOf("alice")}, 'hello')`,
    ).rejects.toMatchObject({ code: "UPM01" });
    // A frozen sender, and a silenced one.
    await setFrozen(db(), "carol", true, "test");
    await expect(
      db()`INSERT INTO messages (bot_id, to_bot_id, key_id, body)
           VALUES (${await idOf("carol")}, ${await idOf("alice")},
                   ${await keyOf("carol")}, 'hello')`,
    ).rejects.toThrow();
    await setFrozen(db(), "carol", false, "test");
    await db()`UPDATE bots SET silenced_until = now() + interval '1 hour'
               WHERE handle = 'carol'`;
    await expect(send(c, "alice", "hello")).resolves.toMatchObject({
      status: 403,
    });
    await expect(
      db()`INSERT INTO messages (bot_id, to_bot_id, key_id, body)
           VALUES (${await idOf("carol")}, ${await idOf("alice")},
                   ${await keyOf("carol")}, 'hello')`,
    ).rejects.toThrow();
    expect(a.handle).toBe("alice");
    expect(await counts()).toEqual({
      channels: 0,
      members: 0,
      direct: 0,
      messages: 0,
    });
  });

  it("stays the same channel when the pair pairs after writing, blocks, unblocks and removes each other", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await send(a, "bob", "hello");
    const first = await channelOf("alice", "bob");
    expect((await pair(a, b)).status).toBe(200);
    expect(
      (await call(blockRoute, { key: b.key, params: { handle: "alice" } }))
        .status,
    ).toBeLessThan(300);
    expect(
      (await call(unblockRoute, { key: b.key, params: { handle: "alice" } }))
        .status,
    ).toBeLessThan(300);
    expect((await send(b, "alice", "again")).status).toBe(201);
    expect((await pair(a, b)).status).toBe(200);
    expect(
      (
        await call(removeRoute, {
          key: a.key,
          method: "DELETE",
          params: { handle: "bob" },
        })
      ).status,
    ).toBeLessThan(300);
    expect((await send(b, "alice", "still here")).status).toBe(201);
    const after = await channelOf("alice", "bob");
    expect(after).toEqual(first);
    // Made by the first message: via stays message, and no new member rows.
    expect(after?.members.map((m) => m.via)).toEqual(["message", "message"]);
    const c = await counts();
    expect([c.channels, c.members, c.direct]).toEqual([1, 2, 1]);
    const rows = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM messages`;
    expect(new Set(rows.map((r) => Number(r.channel_id)))).toEqual(
      new Set([first?.id]),
    );
  });

  it("can't be named by a pair's first message as another pair's channel", async () => {
    const a = await bot("alice");
    await bot("bob");
    const c = await bot("carol");
    await send(c, "alice", "hi");
    const other = await channelOf("carol", "alice");
    await expect(
      db()`INSERT INTO messages (bot_id, to_bot_id, key_id, body, channel_id)
           VALUES (${await idOf("alice")}, ${await idOf("bob")},
                   ${await keyOf("alice")}, 'sideways', ${other?.id ?? null})`,
    ).rejects.toMatchObject({ code: "UPR01" });
    expect(await channelOf("alice", "bob")).toBeUndefined();
    expect(a.handle).toBe("alice");
  });

  it("dates a block by when it was written, not when its transaction began", async () => {
    const a = await bot("alice");
    await bot("bob");
    const [row] = await db().begin(async (tx) => {
      const [began] = await tx<{ t: Date }[]>`SELECT now() AS t`;
      await tx`SELECT pg_sleep(0.05)`;
      await tx`
        INSERT INTO message_blocks (bot_id, blocked_bot_id, key_id, blocked)
        VALUES (${await idOf("alice")}, ${await idOf("bob")},
                ${await keyOf("alice")}, true)`;
      return tx<{ after: boolean }[]>`
        SELECT max(created_at) > ${began?.t ?? null} AS after
        FROM message_blocks`;
    });
    expect(row?.after).toBe(true);
    expect(a.handle).toBe("alice");
  });
});

describe("a channel's messages", () => {
  it("are read through channel_messages(c), the ones from before the channel included", async () => {
    let a: Bot | undefined;
    await beforeChannels(async () => {
      a = await bot("alice");
      const b = await bot("bob");
      await send(a, "bob", "old 1");
      await send(b, "alice", "old 2");
    });
    await db()`SELECT backfill_direct_channels()`;
    if (!a) throw new Error("no alice");
    await send(a, "bob", "new");
    const c = await bot("carol");
    await send(c, "alice", "elsewhere");
    const ch = await channelOf("alice", "bob");
    const rows = await db()<{ body: string }[]>`
      SELECT body FROM channel_messages(${ch?.id ?? null})`;
    expect(rows.map((r) => r.body)).toEqual(["old 1", "old 2", "new"]);
  });
});

describe("the backfill", () => {
  it("gives every pair with a message or a contact one channel, oldest first, and does nothing twice", async () => {
    // Messages and contacts from before private channels: written with the
    // channel triggers off, as the tables held them before the migration.
    await db()`ALTER TABLE messages DISABLE TRIGGER messages_zz_set_channel`;
    await db()`ALTER TABLE contacts DISABLE TRIGGER contacts_set_channel`;
    await db()`ALTER TABLE messages DROP CONSTRAINT messages_have_channel`;
    let alice: Bot;
    try {
      const a = await bot("alice");
      alice = a;
      const b = await bot("bob", false);
      const c = await bot("carol");
      await send(c, "alice", "first");
      await send(a, "carol", "back");
      const made = await call(createRoute, { key: a.key, body: {} });
      await call(redeemRoute, { key: b.key, body: { code: made.body.code } });
      expect((await counts()).channels).toBe(0);
    } finally {
      await db()`ALTER TABLE messages ENABLE TRIGGER messages_zz_set_channel`;
      await db()`ALTER TABLE contacts ENABLE TRIGGER contacts_set_channel`;
      await db()`ALTER TABLE messages ADD CONSTRAINT messages_have_channel
                 CHECK (channel_id IS NOT NULL) NOT VALID`;
    }
    await db()`SELECT backfill_direct_channels()`;
    const ac = await channelOf("alice", "carol");
    const ab = await channelOf("alice", "bob");
    expect(ac?.members.map((m) => [m.via, m.from])).toEqual([
      ["backfill", "0"],
      ["backfill", "0"],
    ]);
    expect(ab?.members).toHaveLength(2);
    // Oldest pair first.
    expect(Number(ac?.id)).toBeLessThan(Number(ab?.id));
    await db()`SELECT backfill_direct_channels()`;
    expect((await counts()).channels).toBe(2);
    // The old messages keep none; the next one goes to the backfilled
    // channel.
    expect((await send(alice, "carol", "after")).status).toBe(201);
    const rows = await db()<{ channel_id: string | null }[]>`
      SELECT channel_id FROM messages ORDER BY id`;
    expect(rows.map((r) => r.channel_id && Number(r.channel_id))).toEqual([
      null,
      null,
      ac?.id,
    ]);
  });
});

describe("the backfill, at the edges", () => {
  it("gives one channel to a pair with both messages and a contact, to a pair whose contact ended, and to a frozen bot's pair", async () => {
    await beforeChannels(async () => {
      const a = await bot("alice");
      const b = await bot("bob");
      const c = await bot("carol");
      const d = await bot("dave");
      await send(a, "bob", "hello");
      await pair(a, b);
      await pair(c, a);
      await call(removeRoute, {
        key: c.key,
        method: "DELETE",
        params: { handle: "alice" },
      });
      await send(d, "alice", "hi");
      await setFrozen(db(), "dave", true, "test");
    });
    expect(await db()`SELECT backfill_direct_channels() AS n`).toEqual([
      { n: 3 },
    ]);
    for (const [x, y] of [
      ["alice", "bob"],
      ["alice", "carol"],
      ["alice", "dave"],
    ] as const)
      expect((await channelOf(x, y))?.members).toHaveLength(2);
    const c = await counts();
    expect([c.channels, c.members, c.direct]).toEqual([3, 6, 3]);
  });

  it("is safe to run on a live site, while a pair's first message is being written", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      let a: Bot | undefined;
      let b: Bot | undefined;
      await beforeChannels(async () => {
        a = await bot("alice");
        b = await bot("bob");
        await bot("carol");
        await send(a, "carol", "old");
      });
      if (!a || !b) throw new Error("no bots");
      const [x, n] = await Promise.all([
        send(a, "bob", "first"),
        db()`SELECT backfill_direct_channels() AS n`,
      ]);
      expect(x.status).toBe(201);
      expect(n[0]?.n).toBe(1);
      const c = await counts();
      expect([c.channels, c.direct]).toEqual([2, 2]);
    }
  });
});
