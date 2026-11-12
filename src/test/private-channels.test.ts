import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as createRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
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
    expect((await send(a, "bob", "again")).status).toBe(201);
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
