import { beforeEach, describe, expect, it } from "vitest";
import { POST as revoke } from "@/app/v1/me/keys/revoke/route";
import { POST as rotate } from "@/app/v1/me/keys/rotate/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as post } from "@/app/v1/posts/route";
import { db } from "@/lib/db";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

describe("a bot can't act as another bot", () => {
  it("attributes a post only to the bot whose key sent it", async () => {
    const alice = await register("alice");
    const bob = await register("bob");
    const res = await call(post, {
      key: alice.key,
      body: { channel: "small-talk", body: "hi from alice" },
    });
    expect(res.status).toBe(201);
    expect(res.body.post.author.handle).toBe("alice");

    const [row] = await db()<{ handle: string; key_id: string }[]>`
      SELECT b.handle, p.key_id FROM posts p JOIN bots b ON b.id = p.bot_id`;
    expect(row?.handle).toBe("alice");
    const [bobKey] = await db()<{ id: string }[]>`
      SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id WHERE b.handle = ${bob.handle}`;
    expect(row?.key_id).not.toBe(bobKey?.id);
  });

  it("rejects any attempt to name the author in the body", async () => {
    const alice = await register("alice");
    await register("bob");
    for (const field of [
      { bot_id: 2 },
      { author: "bob" },
      { handle: "bob" },
      { bot: "bob" },
    ]) {
      const res = await call(post, {
        key: alice.key,
        body: { channel: "small-talk", body: "pretending", ...field },
      });
      expect(res.status).toBe(400);
    }
    const [{ count } = { count: -1 }] = await db()<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM posts`;
    expect(count).toBe(0);
  });

  it("logs every write against the acting bot and key", async () => {
    const alice = await register("alice");
    await call(post, {
      key: alice.key,
      body: { channel: "meta", body: "hello" },
    });
    const rows = await db()<
      { action: string; handle: string; key_ok: boolean }[]
    >`
      SELECT l.action, b.handle, (k.bot_id = l.bot_id) AS key_ok
      FROM action_log l JOIN bots b ON b.id = l.bot_id JOIN api_keys k ON k.id = l.key_id
      ORDER BY l.id`;
    expect(rows.map((r) => [r.action, r.handle, r.key_ok])).toEqual([
      ["bot.register", "alice", true],
      ["post.create", "alice", true],
    ]);
  });
});

describe("keys", () => {
  it("refuses writes with no key, a malformed key or an unknown key", async () => {
    const body = { channel: "meta", body: "x" };
    expect((await call(post, { body })).status).toBe(401);
    expect((await call(post, { body, key: "not-a-key" })).status).toBe(401);
    expect(
      (await call(post, { body, key: `unp_${"A".repeat(43)}` })).status,
    ).toBe(401);
  });

  it("stores only a hash, never the key itself", async () => {
    const alice = await register("alice");
    const tables = ["bots", "api_keys", "posts", "action_log", "rate_limits"];
    for (const t of tables) {
      const rows = await db().unsafe(
        `SELECT row_to_json(t)::text AS j FROM ${t} t`,
      );
      for (const r of rows) expect(r.j).not.toContain(alice.key);
    }
  });

  it("rotates: the old key stops working and the new one works", async () => {
    const alice = await register("alice");
    const res = await call(rotate, { key: alice.key, method: "POST" });
    expect(res.status).toBe(200);
    const fresh = res.body.api_key as string;
    expect(fresh).not.toBe(alice.key);
    expect((await call(me, { key: alice.key })).status).toBe(401);
    const who = await call(me, { key: fresh });
    expect(who.status).toBe(200);
    expect(who.body.bot.handle).toBe("alice");
  });

  it("revokes: the key stops working for reads and writes", async () => {
    const alice = await register("alice");
    expect(
      (await call(revoke, { key: alice.key, method: "POST" })).status,
    ).toBe(200);
    expect((await call(me, { key: alice.key })).status).toBe(401);
    expect(
      (
        await call(post, {
          key: alice.key,
          body: { channel: "meta", body: "x" },
        })
      ).status,
    ).toBe(401);
    expect(
      (await call(revoke, { key: alice.key, method: "POST" })).status,
    ).toBe(401);
  });

  it("does not let one bot revoke another bot's key", async () => {
    const alice = await register("alice");
    const bob = await register("bob");
    await call(revoke, { key: alice.key, method: "POST" });
    expect((await call(me, { key: bob.key })).status).toBe(200);
  });
});
