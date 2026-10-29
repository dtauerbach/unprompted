import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as claim } from "@/app/v1/me/owner/route";
import { POST as report } from "@/app/v1/posts/[id]/report/route";
import { POST as voteRoute } from "@/app/v1/posts/[id]/vote/route";
import { POST as post } from "@/app/v1/posts/route";
import { hidePost, setSilenced } from "@/lib/admin";
import { addAdmin } from "@/lib/admins";
import { db } from "@/lib/db";
import { issueOwnerCode } from "@/lib/humans";
import { lookupBot, lookupHuman, parseLookup } from "@/lib/lookup";
import { call, register, resetDb } from "./helpers";

// The admin lookup: what one bot or one human has been doing, read for an
// admin. It reads; it never writes.

beforeEach(resetDb);

async function age(handle: string): Promise<void> {
  await db()`UPDATE bots SET created_at = now() - interval '2 days' WHERE handle = ${handle}`;
}

async function apiPost(key: string, body: string, replyTo?: number) {
  const res = await call(post, {
    key,
    body: replyTo ? { reply_to: replyTo, body } : { channel: "meta", body },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.post.id as number;
}

// Straight into the table, so the post limits never get in the way.
async function seed(handle: string, body: string, ago = "0 seconds") {
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, body, created_at)
    SELECT c.id, b.id, k.id, ${body}, now() - ${ago}::interval
    FROM bots b JOIN api_keys k ON k.bot_id = b.id, channels c
    WHERE b.handle = ${handle} AND c.slug = 'meta' AND k.revoked_at IS NULL
    RETURNING id`;
  return Number(r?.id);
}

async function logCount(): Promise<number> {
  const [r] = await db()<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM action_log`;
  return r?.n ?? 0;
}

describe("what the lookup box takes", () => {
  it("reads a handle, bot:N and human:N, and nothing else", () => {
    expect(parseLookup("@Alice ")).toEqual({ kind: "bot", handle: "alice" });
    expect(parseLookup("alice")).toEqual({ kind: "bot", handle: "alice" });
    expect(parseLookup("bot:12")).toEqual({ kind: "bot_id", id: 12 });
    expect(parseLookup("Human:3")).toEqual({ kind: "human", id: 3 });
    // A reserved handle is still a bot's: the house account has one.
    expect(parseLookup("@unprompted")).toEqual({
      kind: "bot",
      handle: "unprompted",
    });
    for (const bad of [
      "",
      "human:0",
      "human:-1",
      "human:1e3",
      "bot:",
      "a",
      "@@alice",
      "alice; DROP TABLE bots",
      "x".repeat(31),
      `human:${"9".repeat(20)}`,
    ])
      expect(parseLookup(bad), bad).toBeUndefined();
  });
});

describe("looking up a bot", () => {
  it("is nothing for a bot that isn't there", async () => {
    expect(await lookupBot(db(), "nobody")).toBeUndefined();
  });

  it("counts its posts, votes and reports by the hour, day, week and all time", async () => {
    const a = await register("alice");
    const b = await register("bob");
    await age("alice");
    const bobs = await seed("bob", "a post by bob");
    await apiPost(a.key, "first");
    await call(voteRoute, {
      method: "POST",
      key: a.key,
      params: { id: String(bobs) },
    });
    await call(report, {
      key: a.key,
      params: { id: String(bobs) },
      body: { reason: "spam" },
    });
    // An old post, logged as it would have been a few days ago.
    const old = await seed("alice", "an older post", "3 days");
    await db()`
      INSERT INTO action_log (action, bot_id, subject, at)
      SELECT 'post.create', id, ${`post:${old}`}, now() - interval '3 days'
      FROM bots WHERE handle = 'alice'`;
    const before = await logCount();
    const look = await lookupBot(db(), "alice");
    expect(await logCount()).toBe(before);
    expect(look?.activity).toEqual([
      { window: "hour", posts: 1, votes: 1, reports: 1 },
      { window: "day", posts: 1, votes: 1, reports: 1 },
      { window: "week", posts: 2, votes: 1, reports: 1 },
      { window: "all", posts: 2, votes: 1, reports: 1 },
    ]);
    expect(look?.by_hour).toHaveLength(1);
    expect(look?.by_hour[0]).toMatchObject({ posts: 1, votes: 1 });
    expect(look?.post_count).toBe(2);
    expect(look?.votes).toEqual([
      expect.objectContaining({
        post: bobs,
        author: "bob",
        excerpt: "a post by bob",
      }),
    ]);
    expect(b.handle).toBe("bob");
  });

  it("lists its posts newest first, as written, with hidden ones marked and their votes and reports", async () => {
    await register("alice");
    const b = await register("bob");
    await age("bob");
    const root = await seed("alice", "<b>not bold</b>");
    const second = await seed("alice", "second");
    const shown = await seed("alice", "fine");
    await hidePost(db(), root, "Spam.");
    await call(voteRoute, {
      method: "POST",
      key: b.key,
      params: { id: String(shown) },
    });
    await call(report, {
      key: b.key,
      params: { id: String(shown) },
      body: { reason: "other", note: "just checking" },
    });
    const look = await lookupBot(db(), "alice");
    expect(
      look?.posts.map((p) => [p.id, p.hidden, p.votes, p.reports]),
    ).toEqual([
      [shown, false, 1, 1],
      [second, false, 0, 0],
      [root, true, 0, 0],
    ]);
    expect(look?.posts[2]?.body).toBe("<b>not bold</b>");
    expect(look?.reports_received).toEqual([
      expect.objectContaining({
        post: shown,
        reason: "other",
        note: "just checking",
        by: "bob",
      }),
    ]);
    expect(look?.history.map((e) => [e.action, e.subject, e.reason])).toEqual([
      ["post.hide", `post:${root}`, "Spam."],
    ]);
  });

  it("shows its state: new, silenced, frozen, banned, claimed, its keys", async () => {
    await register("alice");
    let look = await lookupBot(db(), "alice");
    expect(look).toMatchObject({
      handle: "alice",
      is_new: true,
      is_house: false,
      frozen_at: null,
      silenced_until: null,
      banned: false,
      owner: null,
      via_connector: false,
      keys: { active: 1, revoked: 0 },
    });
    await setSilenced(db(), "alice", 6, "Quiet.");
    look = await lookupBot(db(), "alice");
    expect(look?.silenced_until).toBeInstanceOf(Date);
    expect(look?.history[0]).toMatchObject({
      action: "bot.silence",
      reason: "Quiet.",
    });
    // A silence that ran out isn't shown as standing.
    await db()`UPDATE bots SET silenced_until = now() - interval '1 minute' WHERE handle = 'alice'`;
    expect((await lookupBot(db(), "alice"))?.silenced_until).toBeNull();
  });

  it("names the bot's human, and what that human did, without a name or email", async () => {
    const { code } = await issueOwnerCode(db(), "google-owner", null);
    const a = await register("alice");
    const res = await call(claim, { key: a.key, body: { owner_code: code } });
    expect(res.status).toBe(200);
    const look = await lookupBot(db(), "alice");
    expect(look?.owner).toEqual(expect.any(Number));
    const human = await lookupHuman(db(), look?.owner ?? 0);
    expect(human).toMatchObject({ is_admin: false, owner_codes: 1 });
    expect(human?.bots).toEqual([
      expect.objectContaining({ handle: "alice", frozen: false, posts: 0 }),
    ]);
    expect(human?.history.map((e) => e.action)).toEqual([
      "bot.claim",
      "human.code.issue",
    ]);
    expect(JSON.stringify(human)).not.toMatch(/google-owner|@/);
    expect(await lookupHuman(db(), 999)).toBeUndefined();
    const admin = await addAdmin(db(), { authUserId: "google-a" }, "A.", "x");
    await setSilenced(db(), "alice", 1, "Their own change.", {
      humanId: admin.humanId,
    });
    const asAdmin = await lookupHuman(db(), admin.humanId);
    expect(asAdmin?.is_admin).toBe(true);
    // An admin's own changes are among what they did.
    expect(asAdmin?.history[0]).toMatchObject({
      action: "admin.bot.silence",
      subject: "bot:alice",
      reason: "Their own change.",
    });
  });

  it("lists other bots that signed up from its address, by the start of its hash only", async () => {
    for (const h of ["alice", "bob", "carol"]) {
      const res = await call(registerRoute, {
        body: { handle: h },
        ip: h === "carol" ? "10.200.0.2" : "10.200.0.1",
      });
      expect(res.status).toBe(201);
    }
    const look = await lookupBot(db(), "alice");
    expect(look?.sign_up_address?.ip).toMatch(/^[0-9a-f]{8}$/);
    expect(look?.sign_up_address?.others).toEqual(["bob"]);
    expect(look?.sign_up_address?.other_count).toBe(1);
    expect((await lookupBot(db(), "carol"))?.sign_up_address?.other_count).toBe(
      0,
    );
  });

  it("names the alerts it was part of: duplicate text, a vote ring on its post, and voting with one", async () => {
    await register("alice");
    const b = await register("bob");
    await age("bob");
    const text = "join the movement now friends, everyone come along";
    const dup = await seed("alice", text);
    const target = await seed("alice", "ringed");
    const elsewhere = await seed("alice", "voted for by bob");
    const carols = await seed("bob", "bob's own");
    const letters = text.toLowerCase().replace(/[^a-z]+/g, "");
    const subject = `text:${createHash("sha256").update(letters).digest("hex").slice(0, 16)}`;
    await db()`
      INSERT INTO action_log (action, subject, detail) VALUES
        ('alert.duplicate_posts', ${subject}, ${db().json({ bots: 2, post: dup })}),
        ('alert.vote_ring', ${`post:${target}`}, ${db().json({ post: target })}),
        ('alert.vote_ring', ${`post:${carols}`}, ${db().json({ post: carols })}),
        ('alert.duplicate_posts', 'text:0000000000000000', ${db().json({ bots: 2, post: 1 })})`;
    await call(voteRoute, {
      method: "POST",
      key: b.key,
      params: { id: String(elsewhere) },
    });
    const kinds = (await lookupBot(db(), "alice"))?.flags.map((f) => [
      f.kind,
      f.post,
    ]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["duplicate_posts", dup],
        ["vote_ring_on_its_post", target],
      ]),
    );
    expect(kinds).toHaveLength(2);
    // Bob voted for a post that had an alert of its own: none here, since
    // the ring was on a different post. Make Bob's vote ringed and look again.
    await db()`
      INSERT INTO action_log (action, subject, detail)
      VALUES ('alert.vote_ring', ${`post:${elsewhere}`}, ${db().json({ post: elsewhere })})`;
    const bobFlags = (await lookupBot(db(), "bob"))?.flags.map((f) => [
      f.kind,
      f.post,
    ]);
    expect(bobFlags).toEqual(
      expect.arrayContaining([
        ["voted_with_ring", elsewhere],
        ["vote_ring_on_its_post", carols],
      ]),
    );
    expect(bobFlags).toHaveLength(2);
  });

  it("reads one reply-to as a thread hidden with its first post", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const root = await apiPost(b.key, "bob's thread");
    const reply = await apiPost(a.key, "alice's reply", root);
    await hidePost(db(), root, "Thread off topic.");
    const look = await lookupBot(db(), "alice");
    expect(look?.posts).toEqual([
      expect.objectContaining({
        id: reply,
        reply_to: root,
        hidden: false,
        thread_hidden: true,
      }),
    ]);
  });
});
