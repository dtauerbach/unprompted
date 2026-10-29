import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as meRoute } from "@/app/v1/me/route";
import { POST as report } from "@/app/v1/posts/[id]/report/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import {
  DELETE as unvoteRoute,
  POST as voteRoute,
} from "@/app/v1/posts/[id]/vote/route";
import { POST as post } from "@/app/v1/posts/route";
import {
  banBot,
  hidePost,
  moderatorLog,
  setFrozen,
  setSilenced,
  unbanBot,
  unhidePost,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { databaseRefusal } from "@/lib/http";
import { SILENCE_MAX_HOURS } from "@/lib/silence";
import { call, register, resetDb } from "./helpers";

// Silencing a bot for a while, and banning one: what each stops, what it
// leaves alone, that the database backs up the API, and that each can be
// undone exactly, with every change in the moderators' record.

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

async function age(handle: string): Promise<void> {
  await db()`UPDATE bots SET created_at = now() - interval '2 days' WHERE handle = ${handle}`;
}

async function botId(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

// Straight into the table, so the post limits never get in the way.
async function seed(handle: string, body = "hello"): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, body)
    SELECT c.id, b.id, k.id, ${body}
    FROM bots b JOIN api_keys k ON k.bot_id = b.id, channels c
    WHERE b.handle = ${handle} AND c.slug = 'meta' AND k.revoked_at IS NULL
    RETURNING id`;
  return Number(r?.id);
}

function write(key: string, body = "hello") {
  return call(post, { key, body: { channel: "meta", body } });
}

function voteCall(key: string, id: number, method = "POST") {
  return call(method === "POST" ? voteRoute : unvoteRoute, {
    method,
    key,
    path: `/v1/posts/${id}/vote`,
    params: { id: String(id) },
  });
}

async function hiddenIds(): Promise<number[]> {
  const rows = await db()<{ post_id: string }[]>`
    SELECT post_id FROM hidden_posts ORDER BY post_id`;
  return rows.map((r) => Number(r.post_id));
}

async function counts() {
  const [r] = await db()<
    { posts: number; votes: number; log: number; limits: number }[]
  >`
    SELECT (SELECT count(*) FROM posts)::int AS posts,
           (SELECT count(*) FROM votes)::int AS votes,
           (SELECT count(*) FROM action_log)::int AS log,
           (SELECT coalesce(sum(count), 0) FROM rate_limits)::int AS limits`;
  return r;
}

describe("silencing a bot", () => {
  it("refuses its posts and votes until the time it names, and writes nothing, quota included", async () => {
    const a = await register("alice");
    const b = await register("bob");
    await age("alice");
    const target = await seed("bob");
    const r = await setSilenced(db(), "alice", 6, "Flooding #meta.");
    expect(r.changed).toBe(true);
    expect(r.message).toMatch(
      /^Silenced @alice until \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/,
    );
    const before = await counts();
    const p = await write(a.key);
    expect(p.status).toBe(403);
    expect(p.body.error.code).toBe("silenced");
    expect(p.body.error.message).toMatch(
      /silenced this bot until \d{4}-\d\d-\d\d \d\d:\d\d UTC, so it can't post or vote/,
    );
    const v = await voteCall(a.key, target);
    expect(v.status).toBe(403);
    expect(v.body.error.code).toBe("silenced");
    expect(await counts()).toEqual(before);
    // Other bots aren't touched.
    expect((await write(b.key, "still here")).status).toBe(201);
  });

  it("leaves it reading, reporting and taking back a vote it gave before", async () => {
    const a = await register("alice");
    await register("bob");
    await age("alice");
    const target = await seed("bob");
    expect((await voteCall(a.key, target)).status).toBe(200);
    await setSilenced(db(), "alice", 1, "Cooling off.");
    expect((await call(meRoute, { key: a.key })).status).toBe(200);
    const thread = await call(threadRoute, {
      key: a.key,
      params: { id: String(target) },
    });
    expect(thread.status).toBe(200);
    const rep = await call(report, {
      key: a.key,
      path: `/v1/posts/${target}/report`,
      params: { id: String(target) },
      body: { reason: "spam" },
    });
    expect(rep.status).toBe(200);
    expect((await voteCall(a.key, target, "DELETE")).status).toBe(200);
  });

  it("ends on its own when the time is up", async () => {
    const a = await register("alice");
    await setSilenced(db(), "alice", 1, "Cooling off.");
    expect((await write(a.key)).status).toBe(403);
    await db()`UPDATE bots SET silenced_until = now() - interval '1 second' WHERE handle = 'alice'`;
    expect((await write(a.key)).status).toBe(201);
    // An ended silence isn't there to lift.
    const lift = await setSilenced(db(), "alice", null, "Done.");
    expect(lift).toEqual({
      changed: false,
      message: "@alice wasn't silenced.",
    });
  });

  it("can be lifted early, or started again from now, and logs each with its reason", async () => {
    const a = await register("alice");
    await setSilenced(db(), "alice", 168, "A week off.");
    const [first] = await db()<{ until: Date }[]>`
      SELECT silenced_until AS until FROM bots WHERE handle = 'alice'`;
    await setSilenced(db(), "alice", 1, "Shorter after all.");
    const [second] = await db()<{ until: Date }[]>`
      SELECT silenced_until AS until FROM bots WHERE handle = 'alice'`;
    expect(second?.until.getTime()).toBeLessThan(first?.until.getTime() ?? 0);
    expect(await setSilenced(db(), "alice", null, "Talked it over.")).toEqual({
      changed: true,
      message: "Lifted @alice's silence.",
    });
    expect((await write(a.key)).status).toBe(201);
    const log = await moderatorLog(db(), { limit: 10 });
    expect(log.map((e) => [e.action, e.subject, e.reason])).toEqual([
      ["bot.unsilence", "bot:alice", "Talked it over."],
      ["bot.silence", "bot:alice", "Shorter after all."],
      ["bot.silence", "bot:alice", "A week off."],
    ]);
    const [entry] = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'admin.bot.silence' ORDER BY id LIMIT 1`;
    expect(entry?.detail).toMatchObject({ hours: 168, reason: "A week off." });
    expect(typeof entry?.detail.until).toBe("string");
  });

  it("refuses the house account, a bot that isn't there, a bad length and no reason, writing nothing", async () => {
    await register("alice");
    const before = await counts();
    await expect(setSilenced(db(), HOUSE_HANDLE, 1, "x")).rejects.toMatchObject(
      { code: "house_bot" },
    );
    await expect(setSilenced(db(), "nobody", 1, "x")).rejects.toMatchObject({
      code: "no_such_bot",
    });
    for (const hours of [0, -1, 1.5, SILENCE_MAX_HOURS + 1, Number.NaN])
      await expect(
        setSilenced(db(), "alice", hours, "x"),
      ).rejects.toMatchObject({ code: "invalid_hours" });
    await expect(setSilenced(db(), "alice", 1, "")).rejects.toMatchObject({
      code: "invalid_reason",
    });
    expect(await counts()).toEqual(before);
    // The database won't take a silence on the house account either.
    await syncWelcome(db(), "Welcome.");
    await expect(
      db()`UPDATE bots SET silenced_until = now() + interval '1 hour' WHERE handle = ${HOUSE_HANDLE}`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("is backed up by the database, which the API reports as a silence, not a freeze", async () => {
    await register("alice");
    await register("bob");
    await age("alice");
    const target = await seed("bob");
    await setSilenced(db(), "alice", 1, "x");
    const err = await seed("alice").catch((e) => e);
    expect(err).toMatchObject({ code: "UPS01" });
    expect(databaseRefusal(err)).toMatchObject({
      status: 403,
      code: "silenced",
    });
    await expect(
      db()`INSERT INTO votes (bot_id, post_id) VALUES (${await botId("alice")}, ${target})`,
    ).rejects.toMatchObject({ code: "UPS01" });
    expect(databaseRefusal({ code: "42501" })).toMatchObject({
      code: "frozen",
    });
    expect(databaseRefusal(new Error("other"))).toBeUndefined();
  });
});

describe("banning a bot", () => {
  it("freezes it and hides every post it wrote, as one change in the record", async () => {
    const a = await register("alice");
    await register("bob");
    const one = await seed("alice", "one");
    const two = await seed("alice", "two");
    const bobs = await seed("bob", "bob's");
    const r = await banBot(db(), "alice", "Spam ring.");
    expect(r).toEqual({
      changed: true,
      message: "Banned @alice: froze it and hid 2 post(s).",
    });
    expect(await hiddenIds()).toEqual([one, two]);
    expect((await write(a.key)).status).toBe(403);
    const thread = await call(threadRoute, { params: { id: String(one) } });
    expect(thread.status).toBe(404);
    expect(
      (await call(threadRoute, { params: { id: String(bobs) } })).status,
    ).toBe(200);
    const log = await moderatorLog(db(), { limit: 5 });
    expect(log.map((e) => [e.action, e.reason])).toEqual([
      ["bot.ban", "Spam ring."],
    ]);
    const [entry] = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'admin.bot.ban'`;
    expect(entry?.detail).toMatchObject({ froze: true, posts: [one, two] });
  });

  it("is undone exactly: unbanning puts back what the ban hid and unfreezes it", async () => {
    const a = await register("alice");
    const one = await seed("alice", "one");
    const two = await seed("alice", "two");
    const earlier = await seed("alice", "hidden before");
    await hidePost(db(), earlier, "Its own reason.");
    await banBot(db(), "alice", "Spam ring.");
    expect(await hiddenIds()).toEqual(
      [one, two, earlier].sort((x, y) => x - y),
    );
    const r = await unbanBot(db(), "alice", "Wrong bot.");
    expect(r).toEqual({
      changed: true,
      message: "Unbanned @alice: unfroze it, and put back 2 post(s).",
    });
    // A post hidden for its own reason before the ban stays hidden.
    expect(await hiddenIds()).toEqual([earlier]);
    expect((await write(a.key)).status).toBe(201);
    const [entry] = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'admin.bot.unban'`;
    expect(entry?.detail).toMatchObject({
      unfroze: true,
      posts: [one, two],
      reason: "Wrong bot.",
    });
  });

  it("leaves a moderator's later changes alone when it's undone", async () => {
    await register("alice");
    const one = await seed("alice", "one");
    const two = await seed("alice", "two");
    await banBot(db(), "alice", "Spam ring.");
    // Unhidden and hidden again since, for its own reason.
    await unhidePost(db(), two, "Look again.");
    await hidePost(db(), two, "Still bad.");
    // Unfrozen and frozen again since, apart from the ban.
    await setFrozen(db(), "alice", false, "Talk first.");
    await setFrozen(db(), "alice", true, "No.");
    const r = await unbanBot(db(), "alice", "Wrong bot.");
    expect(r.message).toBe(
      "Unbanned @alice: left it frozen, since that freeze wasn't the ban's, and put back 1 post(s); 1 unhidden or hidden again since stay as they are.",
    );
    expect(await hiddenIds()).toEqual([two]);
    expect(one).toBeLessThan(two);
    const [b] = await db()`SELECT frozen_at FROM bots WHERE handle = 'alice'`;
    expect(b?.frozen_at).not.toBeNull();
  });

  it("doesn't unfreeze a bot that was frozen before the ban", async () => {
    await register("alice");
    await seed("alice");
    await setFrozen(db(), "alice", true, "First.");
    expect((await banBot(db(), "alice", "Then ban.")).message).toBe(
      "Banned @alice: it was already frozen and hid 1 post(s).",
    );
    const r = await unbanBot(db(), "alice", "Undo the ban.");
    expect(r.message).toMatch(/left it frozen/);
    expect(await hiddenIds()).toEqual([]);
  });

  it("does nothing twice, bans again once unfrozen by hand, and one unban undoes both", async () => {
    const a = await register("alice");
    const one = await seed("alice", "one");
    await banBot(db(), "alice", "Spam.");
    expect(await banBot(db(), "alice", "Again.")).toEqual({
      changed: false,
      message: "@alice was already banned.",
    });
    await setFrozen(db(), "alice", false, "Give it a chance.");
    const two = await seed("alice", "two");
    expect((await banBot(db(), "alice", "It went back to it.")).message).toBe(
      "Banned @alice: froze it and hid 1 post(s).",
    );
    expect(await hiddenIds()).toEqual([one, two]);
    await unbanBot(db(), "alice", "Both were wrong.");
    expect(await hiddenIds()).toEqual([]);
    expect((await write(a.key)).status).toBe(201);
    await expect(unbanBot(db(), "alice", "Again.")).rejects.toMatchObject({
      code: "not_banned",
    });
  });

  it("refuses the house account, a bot that isn't there and no reason, writing nothing", async () => {
    await register("alice");
    await syncWelcome(db(), "Welcome.");
    const before = await counts();
    for (const run of [
      () => banBot(db(), HOUSE_HANDLE, "x"),
      () => unbanBot(db(), HOUSE_HANDLE, "x"),
    ])
      await expect(run()).rejects.toMatchObject({ code: "house_bot" });
    await expect(banBot(db(), "nobody", "x")).rejects.toMatchObject({
      code: "no_such_bot",
    });
    await expect(banBot(db(), "alice", "")).rejects.toMatchObject({
      code: "invalid_reason",
    });
    await expect(unbanBot(db(), "alice", "x")).rejects.toMatchObject({
      code: "not_banned",
    });
    expect(await counts()).toEqual(before);
  });
});
