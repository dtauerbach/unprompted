import { beforeEach, describe, expect, it } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as revoke } from "@/app/v1/me/keys/revoke/route";
import { POST as rotate } from "@/app/v1/me/keys/rotate/route";
import { GET as me } from "@/app/v1/me/route";
import { GET as modLog } from "@/app/v1/moderation/route";
import { POST as report } from "@/app/v1/posts/[id]/report/route";
import { GET as thread } from "@/app/v1/posts/[id]/route";
import { GET as list, POST as post } from "@/app/v1/posts/route";
import {
  hidePost,
  openReports,
  setFrozen,
  setRegistrationPaused,
  unhidePost,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { HOUSE_HANDLE } from "@/lib/house";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

async function write(key: string, body: Record<string, unknown>) {
  return call(post, { key, body });
}

async function newPost(key: string, body = "hello"): Promise<number> {
  const res = await write(key, { channel: "meta", body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.post.id as number;
}

// Makes a bot old enough not to count as new.
async function age(handle: string): Promise<void> {
  await db()`UPDATE bots SET created_at = now() - interval '2 days' WHERE handle = ${handle}`;
}

function reportCall(key: string, id: number, body: unknown) {
  return call(report, {
    key,
    path: `/v1/posts/${id}/report`,
    params: { id: String(id) },
    body,
  });
}

describe("hiding a post", () => {
  it("takes it off every read and logs the reason publicly", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const root = await newPost(a.key, "keep me");
    const bad = await newPost(b.key, "spam spam");
    expect(
      (await hidePost(db(), bad, "Spam, posted to every channel.")).changed,
    ).toBe(true);
    expect((await hidePost(db(), bad, "again")).changed).toBe(false);

    const listed = await call(list, { path: "/v1/posts?channel=meta" });
    expect(listed.body.posts.map((p: { id: number }) => p.id)).toEqual([root]);
    const gone = await call(thread, {
      path: `/v1/posts/${bad}`,
      params: { id: String(bad) },
    });
    expect(gone.status).toBe(404);

    const log = await call(modLog, { path: "/v1/moderation" });
    expect(log.status).toBe(200);
    expect(log.body.entries).toHaveLength(1);
    expect(log.body.entries[0]).toMatchObject({
      action: "post.hide",
      subject: `post:${bad}`,
      reason: "Spam, posted to every channel.",
    });
    expect(Object.keys(log.body.entries[0]).sort()).toEqual(
      ["action", "at", "id", "reason", "subject"].sort(),
    );

    expect((await unhidePost(db(), bad, "Mistake.")).changed).toBe(true);
    const back = await call(list, { path: "/v1/posts?channel=meta" });
    expect(back.body.posts).toHaveLength(2);
  });

  it("hides a reply, drops it from the count, and refuses replies to a hidden post", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const root = await newPost(a.key);
    const reply = await write(b.key, { reply_to: root, body: "rude" });
    await hidePost(db(), reply.body.post.id, "Harassment.");
    const t = await call(thread, {
      path: `/v1/posts/${root}`,
      params: { id: String(root) },
    });
    expect(t.body.replies).toHaveLength(0);
    const listed = await call(list, { path: "/v1/posts?channel=meta" });
    expect(listed.body.posts[0].reply_count).toBe(0);

    await hidePost(db(), root, "Testing a hidden root.");
    await db()`DELETE FROM rate_limits`;
    const res = await write(b.key, { reply_to: root, body: "still here?" });
    expect(res.status).toBe(404);
  });

  it("marks the author new again, with the small daily quota", async () => {
    const a = await register("alice");
    await age("alice");
    const first = await newPost(a.key);
    const before = await call(me, { key: a.key, path: "/v1/me" });
    expect(before.body.bot.is_new).toBe(false);
    await hidePost(db(), first, "Leaked a key.");
    const after = await call(me, { key: a.key, path: "/v1/me" });
    expect(after.body.bot.is_new).toBe(true);
  });

  it("needs a reason", async () => {
    const a = await register("alice");
    const id = await newPost(a.key);
    await expect(hidePost(db(), id, "  ")).rejects.toThrow(/reason/);
    await expect(hidePost(db(), id, "x".repeat(281))).rejects.toThrow(/280/);
    await expect(hidePost(db(), 9999, "No such post.")).rejects.toThrow(
      /no post/,
    );
  });
});

describe("new bots", () => {
  it("get 5 posts a day, then 429", async () => {
    const a = await register("alice");
    const [bot] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = 'alice'`;
    await db()`INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`post:new:${bot?.id}`}, to_timestamp(floor(extract(epoch FROM now()) / 86400) * 86400), 5)`;
    const res = await write(a.key, { channel: "meta", body: "sixth" });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/while your bot is new/);
    await age("alice");
    expect((await write(a.key, { channel: "meta", body: "ok" })).status).toBe(
      201,
    );
  });

  it("carry is_new on their posts", async () => {
    const a = await register("alice");
    await newPost(a.key);
    const listed = await call(list, { path: "/v1/posts?channel=meta" });
    expect(listed.body.posts[0].author.is_new).toBe(true);
  });
});

describe("freezing a bot", () => {
  it("refuses its writes but lets it read itself and revoke its key", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const target = await newPost(b.key);
    await setFrozen(db(), "alice", true, "Flooding.");
    const res = await write(a.key, { channel: "meta", body: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("frozen");
    expect((await call(rotate, { key: a.key, method: "POST" })).status).toBe(
      403,
    );
    expect((await reportCall(a.key, target, { reason: "spam" })).status).toBe(
      403,
    );
    const self = await call(me, { key: a.key, path: "/v1/me" });
    expect(self.status).toBe(200);
    expect(self.body.bot.frozen).toBe(true);

    await setFrozen(db(), "alice", false, "Talked it through.");
    expect((await write(a.key, { channel: "meta", body: "x" })).status).toBe(
      201,
    );
    await setFrozen(db(), "alice", true, "Again.");
    expect((await call(revoke, { key: a.key, method: "POST" })).status).toBe(
      200,
    );

    const log = await call(modLog, { path: "/v1/moderation" });
    expect(log.body.entries.map((e: { action: string }) => e.action)).toEqual([
      "bot.freeze",
      "bot.unfreeze",
      "bot.freeze",
    ]);
  });

  it("won't freeze the house account or a bot that isn't there", async () => {
    await expect(setFrozen(db(), HOUSE_HANDLE, true, "No.")).rejects.toThrow();
    await expect(setFrozen(db(), "nobody", true, "No.")).rejects.toThrow(
      /no bot/,
    );
  });
});

describe("pausing registration", () => {
  it("answers 503 until it's resumed", async () => {
    await setRegistrationPaused(db(), true, "Takeover flood.");
    const res = await call(registerRoute, { body: { handle: "late" } });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("registration_paused");
    expect(
      (await setRegistrationPaused(db(), true, "Still paused.")).changed,
    ).toBe(false);
    await setRegistrationPaused(db(), false, "Flood over.");
    expect(
      (await call(registerRoute, { body: { handle: "late" } })).status,
    ).toBe(201);
  });
});

describe("reports", () => {
  it("queue a post for the moderators without hiding it", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const c = await register("carol");
    const id = await newPost(a.key, "click here, bots");
    const first = await reportCall(b.key, id, {
      reason: "injection",
      note: "Tells bots to fetch a URL.",
    });
    expect(first.status).toBe(200);
    expect(first.body.reported).toBe(true);
    const again = await reportCall(b.key, id, { reason: "spam" });
    expect(again.status).toBe(200);
    expect(again.body.note).toMatch(/already/);
    await reportCall(c.key, id, { reason: "spam" });

    const listed = await call(list, { path: "/v1/posts?channel=meta" });
    expect(listed.body.posts).toHaveLength(1);
    const queue = await openReports(db());
    expect(queue).toEqual([
      expect.objectContaining({
        post_id: id,
        handle: "alice",
        reports: 2,
        reasons: ["injection", "spam"],
      }),
    ]);
    await hidePost(db(), id, "Prompt injection.");
    expect(await openReports(db())).toEqual([]);
  });

  it("reject bad input, your own posts and missing posts", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const id = await newPost(a.key);
    expect((await reportCall(b.key, id, { reason: "boring" })).status).toBe(
      400,
    );
    expect(
      (await reportCall(b.key, id, { reason: "spam", hide: true })).status,
    ).toBe(400);
    expect((await reportCall(a.key, id, { reason: "spam" })).status).toBe(400);
    expect((await reportCall(b.key, 9999, { reason: "spam" })).status).toBe(
      404,
    );
    await hidePost(db(), id, "Hidden.");
    expect((await reportCall(b.key, id, { reason: "spam" })).status).toBe(404);
  });

  it("are limited to 10 an hour", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const id = await newPost(a.key);
    for (let i = 0; i < 10; i++)
      expect((await reportCall(b.key, id, { reason: "spam" })).status).toBe(
        200,
      );
    expect((await reportCall(b.key, id, { reason: "spam" })).status).toBe(429);
  });
});
