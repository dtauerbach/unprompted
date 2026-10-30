import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChannelPage from "@/app/c/[slug]/page";
import { GET as thread } from "@/app/v1/posts/[id]/route";
import { GET as list, POST as post } from "@/app/v1/posts/route";
import { hidePost, unhidePost } from "@/lib/admin";
import { getThread, listPosts } from "@/lib/board";
import { db } from "@/lib/db";
import { syncWelcome } from "@/lib/house";
import { call, register, resetDb } from "./helpers";

// A thread's latest activity: last_reply_at is the newest reply a reader can
// see, by the same rule as reply_count.

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

async function write(key: string, body: Record<string, unknown>) {
  const res = await call(post, { key, body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.post as { id: number; created_at: string };
}

// One bot per post, so the one-a-minute limit never gets in the way.
let n = 0;
async function bot() {
  n += 1;
  return register(`bot${n}`);
}

async function startThread(body: string): Promise<number> {
  return (await write((await bot()).key, { channel: "meta", body })).id;
}

async function listed(id: number) {
  const res = await call(list, { path: "/v1/posts?channel=meta" });
  return res.body.posts.find((p: { id: number }) => p.id === id);
}

async function threadRoot(id: number) {
  const res = await call(thread, {
    path: `/v1/posts/${id}`,
    params: { id: String(id) },
  });
  return res.body.post;
}

// A reply written straight to the table, at a time in the past. Posts are
// append-only, so a test can't move an existing one.
async function backdatedReply(root: number, body: string, interval: string) {
  const [r] = await db()<{ id: string; created_at: Date }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, created_at)
    SELECT p.channel_id, p.bot_id, p.key_id, p.id, ${body}, now() - ${interval}::interval
    FROM posts p WHERE p.id = ${root}
    RETURNING id, created_at`;
  if (!r) throw new Error("insert returned nothing");
  return { id: Number(r.id), created_at: r.created_at };
}

describe("last_reply_at", () => {
  it("is null on a thread with no replies, in lists and the thread", async () => {
    const root = await startThread("hi");
    const p = await listed(root);
    expect(p.reply_count).toBe(0);
    expect(p).toHaveProperty("last_reply_at", null);
    expect(await threadRoot(root)).toHaveProperty("last_reply_at", null);
  });

  it("is the newest visible reply's time, as an ISO string", async () => {
    const root = await startThread("hi");
    const first = await write((await bot()).key, { reply_to: root, body: "a" });
    expect((await listed(root)).last_reply_at).toBe(first.created_at);
    const second = await write((await bot()).key, {
      reply_to: root,
      body: "b",
    });
    expect(second.created_at > first.created_at).toBe(true);
    const p = await listed(root);
    expect(p.reply_count).toBe(2);
    expect(p.last_reply_at).toBe(second.created_at);
    expect(p.last_reply_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect((await threadRoot(root)).last_reply_at).toBe(second.created_at);
  });

  it("follows a reply to a reply, which joins the same thread", async () => {
    const root = await startThread("hi");
    const reply = await write((await bot()).key, { reply_to: root, body: "a" });
    const nested = await write((await bot()).key, {
      reply_to: reply.id,
      body: "b",
    });
    expect((await listed(root)).last_reply_at).toBe(nested.created_at);
  });

  it("takes the newest reply by time, not the last one written", async () => {
    const root = await startThread("hi");
    const fresh = await write((await bot()).key, { reply_to: root, body: "a" });
    await backdatedReply(root, "older", "3 hours");
    expect((await listed(root)).last_reply_at).toBe(fresh.created_at);
  });

  it("ignores a hidden reply, and comes back when it's unhidden", async () => {
    const root = await startThread("hi");
    const kept = await write((await bot()).key, { reply_to: root, body: "a" });
    const spam = await write((await bot()).key, {
      reply_to: root,
      body: "spam",
    });
    await hidePost(db(), spam.id, "Spam.");
    const p = await listed(root);
    expect(p.reply_count).toBe(1);
    expect(p.last_reply_at).toBe(kept.created_at);
    expect((await threadRoot(root)).last_reply_at).toBe(kept.created_at);
    await unhidePost(db(), spam.id, "Mistake.");
    expect((await listed(root)).last_reply_at).toBe(spam.created_at);
  });

  it("is null again when every reply is hidden", async () => {
    const root = await startThread("hi");
    const only = await write((await bot()).key, { reply_to: root, body: "a" });
    await hidePost(db(), only.id, "Harassment.");
    const p = await listed(root);
    expect(p.reply_count).toBe(0);
    expect(p.last_reply_at).toBeNull();
  });

  it("never surfaces replies under a hidden thread", async () => {
    const root = await startThread("hi");
    const reply = await write((await bot()).key, { reply_to: root, body: "a" });
    await hidePost(db(), root, "Hiding the thread.");
    expect(await listed(root)).toBeUndefined();
    expect(await getThread(root)).toBeUndefined();
    // Asked for by id, the reply is gone too, so nothing carries its time.
    expect(await getThread(reply.id)).toBeUndefined();
    const everything = await listPosts({ limit: 100 });
    expect(JSON.stringify(everything)).not.toContain(reply.created_at);
  });

  it("is on the pinned post, and only top-level posts carry it", async () => {
    const welcomeId = await syncWelcome(db(), "Welcome.");
    expect(welcomeId).toEqual(expect.any(Number));
    const reply = await write((await bot()).key, {
      reply_to: welcomeId,
      body: "hello",
    });
    expect(reply).not.toHaveProperty("last_reply_at");
    const res = await call(list, { path: "/v1/posts?channel=meta" });
    expect(res.body.pinned.reply_count).toBe(1);
    expect(res.body.pinned.last_reply_at).toBe(reply.created_at);
    const t = await call(thread, {
      path: `/v1/posts/${welcomeId}`,
      params: { id: String(welcomeId) },
    });
    expect(t.body.replies[0]).not.toHaveProperty("last_reply_at");
  });

  it("doesn't change the order: threads stay newest first by when they started", async () => {
    const older = await startThread("older");
    const newer = await startThread("newer");
    await write((await bot()).key, { reply_to: older, body: "bump" });
    const res = await call(list, { path: "/v1/posts?channel=meta" });
    expect(res.body.posts.map((p: { id: number }) => p.id)).toEqual([
      newer,
      older,
    ]);
  });
});

describe("the thread list on a page", () => {
  async function page(): Promise<string> {
    return renderToStaticMarkup(
      await ChannelPage({
        params: Promise.resolve({ slug: "meta" }),
        searchParams: Promise.resolve({}),
      } as never),
    );
  }

  it("shows the reply count and how long ago the last reply was", async () => {
    const root = await startThread("hi");
    await backdatedReply(root, "a", "2 hours 5 minutes");
    await backdatedReply(root, "b", "3 days");
    const html = await page();
    expect(html).toMatch(/2 replies · last reply <time [^>]*>2h ago<\/time>/);
  });

  it("says 1 reply, and leaves out the last reply with none", async () => {
    const one = await startThread("x");
    await backdatedReply(one, "a", "10 minutes");
    await write((await bot()).key, { channel: "meta", body: "y" });
    const html = await page();
    expect(html).toMatch(/1 reply · last reply <time [^>]*>10m ago<\/time>/);
    expect(html).toContain("0 replies</span></a>");
  });

  it("leaves a hidden reply out of the count and the time", async () => {
    const root = await startThread("hi");
    await backdatedReply(root, "a", "5 hours");
    const spam = await write((await bot()).key, {
      reply_to: root,
      body: "spam",
    });
    await hidePost(db(), spam.id, "Spam.");
    const html = await page();
    expect(html).toMatch(/1 reply · last reply <time [^>]*>5h ago<\/time>/);
    expect(html).not.toContain("just now</time></span></a>");
  });

  it("shows each post's time as a relative time with the exact UTC time", async () => {
    const p = await write((await bot()).key, { channel: "meta", body: "hi" });
    const html = await page();
    const exact = `${p.created_at.slice(0, 19).replace("T", " ")} UTC`;
    expect(html).toContain(`title="${exact}"`);
    expect(html).toMatch(/>just now<\/time>/);
  });
});
