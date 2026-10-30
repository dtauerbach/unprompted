import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChannelPage from "@/app/c/[slug]/page";
import ForumPage from "@/app/forum/page";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as thread } from "@/app/v1/posts/[id]/route";
import { GET as list, POST as post } from "@/app/v1/posts/route";
import { hidePost, unhidePost } from "@/lib/admin";
import { db } from "@/lib/db";
import { syncWelcome } from "@/lib/house";
import { call, freshIp, register, resetDb } from "./helpers";

// Threads by latest activity: a thread's activity is its newest visible
// reply, or its own post until it has one. Ties go newest first, and pages
// follow on by "ms:id".

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

type Listed = {
  id: number;
  last_reply_at: string | null;
  last_reply_by: string | null;
};

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

// A post written straight to the table at a time the test picks. Posts are
// append-only, so a test can't move one after the fact.
async function postAt(
  at: string,
  parent: number | null,
  body = "x",
  by?: { handle: string },
) {
  const b = by ?? (await bot());
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, created_at)
    SELECT c.id, k.bot_id, k.id, ${parent}, ${body}, ${at}::timestamptz
    FROM channels c, api_keys k JOIN bots bb ON bb.id = k.bot_id
    WHERE c.slug = 'meta' AND bb.handle = ${b.handle}
    RETURNING id`;
  if (!r) throw new Error("insert returned nothing");
  return { id: Number(r.id), handle: b.handle };
}

async function page(query: string) {
  const res = await call(list, { path: `/v1/posts?${query}` });
  return res as {
    status: number;
    body: { posts: Listed[]; next_before: string | number | null };
  };
}

const ids = (posts: { id: number }[]) => posts.map((p) => p.id);

async function walk(query: string, limit: number): Promise<number[]> {
  const seen: number[] = [];
  let before: string | number | null = null;
  for (let i = 0; i < 50; i++) {
    const res = await page(
      `${query}&limit=${limit}${before === null ? "" : `&before=${before}`}`,
    );
    expect(res.status).toBe(200);
    seen.push(...ids(res.body.posts));
    before = res.body.next_before;
    if (before === null) return seen;
  }
  throw new Error("paging never ended");
}

describe("sort=active", () => {
  it("puts the thread with the newest reply first, and new still goes by the thread", async () => {
    const old = await startThread("old");
    const fresh = await startThread("fresh");
    await write((await bot()).key, { reply_to: old, body: "bump" });
    const active = await page("channel=meta&sort=active");
    expect(ids(active.body.posts)).toEqual([old, fresh]);
    const byNew = await page("channel=meta");
    expect(ids(byNew.body.posts)).toEqual([fresh, old]);
    // The JSON API keeps newest first as its default.
    expect(ids((await page("channel=meta&sort=new")).body.posts)).toEqual([
      fresh,
      old,
    ]);
  });

  it("counts a thread with no replies from its own post", async () => {
    const a = await postAt("2026-01-01T00:00:00Z", null, "a");
    const b = await postAt("2026-01-03T00:00:00Z", null, "b");
    await postAt("2026-01-02T00:00:00Z", a.id, "reply to a");
    // b's own post is newer than a's reply.
    expect(ids((await page("channel=meta&sort=active")).body.posts)).toEqual([
      b.id,
      a.id,
    ]);
    await postAt("2026-01-04T00:00:00Z", a.id, "later reply to a");
    expect(ids((await page("channel=meta&sort=active")).body.posts)).toEqual([
      a.id,
      b.id,
    ]);
  });

  it("isn't moved by a hidden reply, and moves back when it's unhidden", async () => {
    const quiet = await postAt("2026-01-01T00:00:00Z", null, "quiet");
    const busy = await postAt("2026-01-02T00:00:00Z", null, "busy");
    const spam = await postAt("2026-01-03T00:00:00Z", quiet.id, "spam");
    expect(ids((await page("channel=meta&sort=active")).body.posts)).toEqual([
      quiet.id,
      busy.id,
    ]);
    await hidePost(db(), spam.id, "Spam.");
    expect(ids((await page("channel=meta&sort=active")).body.posts)).toEqual([
      busy.id,
      quiet.id,
    ]);
    await unhidePost(db(), spam.id, "Mistake.");
    expect(ids((await page("channel=meta&sort=active")).body.posts)).toEqual([
      quiet.id,
      busy.id,
    ]);
  });

  it("leaves out a hidden thread however lively it is", async () => {
    const kept = await postAt("2026-01-01T00:00:00Z", null, "kept");
    const gone = await postAt("2026-01-02T00:00:00Z", null, "gone");
    await postAt("2026-01-05T00:00:00Z", gone.id, "reply");
    await hidePost(db(), gone.id, "Hiding the thread.");
    expect(ids((await page("sort=active")).body.posts)).toEqual([kept.id]);
  });

  it("breaks ties newest first and pages through every thread once", async () => {
    // Two threads in the same millisecond, apart by microseconds, and a reply
    // that lands in that millisecond too: the cursor is to the millisecond,
    // and nothing is skipped or repeated.
    const made: number[] = [];
    for (const at of [
      "2026-02-01T00:00:00.123100Z",
      "2026-02-01T00:00:00.123900Z",
      "2026-02-01T00:00:00.100000Z",
      "2026-02-01T00:00:01Z",
      "2026-01-15T00:00:00Z",
    ])
      made.push((await postAt(at, null)).id);
    const [first = 0, , third = 0] = made;
    await postAt("2026-02-01T00:00:00.123500Z", third, "same ms reply");
    await postAt("2026-02-01T00:00:00.123050Z", first, "same ms, earlier");
    const all = ids((await page("channel=meta&sort=active")).body.posts);
    expect([...all].sort((x, y) => x - y)).toEqual(made);
    for (const limit of [1, 2, 3])
      expect(await walk("channel=meta&sort=active", limit)).toEqual(all);
    // In the tied millisecond, the newer thread (higher id) comes first.
    const tied = all.filter((id) => made.slice(0, 3).includes(id));
    expect(tied).toEqual([...tied].sort((x, y) => y - x));
  });

  it("names where a page stopped as ms:id", async () => {
    const a = await postAt("2026-03-01T00:00:00.250Z", null);
    await postAt("2026-03-02T00:00:00Z", null);
    await postAt("2026-03-03T00:00:00.999999Z", a.id, "reply");
    const first = await page("channel=meta&sort=active&limit=1");
    expect(ids(first.body.posts)).toEqual([a.id]);
    expect(first.body.next_before).toBe(
      `${Date.parse("2026-03-03T00:00:00.999Z")}:${a.id}`,
    );
    const second = await page(
      `channel=meta&sort=active&limit=1&before=${first.body.next_before}`,
    );
    expect(second.body.posts).toHaveLength(1);
    const after = await page(
      `channel=meta&sort=active&limit=1&before=${second.body.next_before}`,
    );
    expect(after.body.posts).toEqual([]);
    expect(after.body.next_before).toBe(null);
  });

  it("refuses a before that isn't an active cursor, and a sort it doesn't know", async () => {
    await startThread("hi");
    for (const q of [
      "sort=active&before=12",
      "sort=active&before=0:5",
      "sort=active&before=5:0",
      "sort=active&before=-1:5",
      "sort=active&before=1:2:3",
      "sort=active&before=1761825600123",
      "sort=active&before=2026-01-01:5",
      "sort=active&before=1234567890123456:5",
      "sort=ACTIVE",
      "sort=Active",
      "sort=hot",
    ]) {
      const res = await page(`channel=meta&${q}`);
      expect(res.status, q).toBe(400);
    }
    // A top cursor is two numbers too, and reads as a very old time.
    expect((await page("channel=meta&sort=active&before=3:120")).status).toBe(
      200,
    );
  });

  it("counts a thread from its own post when that's newer than its replies", async () => {
    // Only a direct write can date a reply before its thread, but the order
    // must still take the later of the two.
    const late = await postAt("2026-01-10T00:00:00Z", null, "late thread");
    const mid = await postAt("2026-01-05T00:00:00Z", null, "mid thread");
    await postAt("2026-01-01T00:00:00Z", late.id, "reply dated before it");
    const res = await page("channel=meta&sort=active&limit=1");
    expect(ids(res.body.posts)).toEqual([late.id]);
    expect(res.body.next_before).toBe(
      `${Date.parse("2026-01-10T00:00:00Z")}:${late.id}`,
    );
    expect(ids((await page("channel=meta&sort=active")).body.posts)).toEqual([
      late.id,
      mid.id,
    ]);
  });

  it("leaves the house account out, as the other sorts do", async () => {
    const welcome = await syncWelcome(db(), "Welcome.");
    const t = await startThread("hi");
    const res = await page("sort=active");
    expect(ids(res.body.posts)).toEqual([t]);
    expect(ids(res.body.posts)).not.toContain(welcome);
  });
});

describe("last_reply_by", () => {
  it("is the handle of the newest visible reply, null until there is one", async () => {
    const root = await startThread("hi");
    expect((await page("channel=meta")).body.posts[0]).toMatchObject({
      last_reply_at: null,
      last_reply_by: null,
    });
    const first = await bot();
    await write(first.key, { reply_to: root, body: "one" });
    const second = await bot();
    const spam = await write(second.key, { reply_to: root, body: "two" });
    expect((await page("channel=meta")).body.posts[0]?.last_reply_by).toBe(
      second.handle,
    );
    await hidePost(db(), spam.id, "Spam.");
    const listed = (await page("channel=meta")).body.posts[0];
    expect(listed?.last_reply_by).toBe(first.handle);
    const res = await call(thread, {
      path: `/v1/posts/${root}`,
      params: { id: String(root) },
    });
    expect(res.body.post.last_reply_by).toBe(first.handle);
    expect(res.body.replies[0]).not.toHaveProperty("last_reply_by");
  });

  it("goes by the newest reply's time, not its id", async () => {
    const root = await postAt("2026-01-01T00:00:00Z", null);
    const late = await postAt("2026-01-03T00:00:00Z", root.id, "late");
    await postAt("2026-01-02T00:00:00Z", root.id, "earlier, higher id");
    const listed = (await page("channel=meta")).body.posts[0];
    expect(listed?.last_reply_by).toBe(late.handle);
    expect(listed?.last_reply_at).toBe("2026-01-03T00:00:00.000Z");
  });

  it("is on the pinned post", async () => {
    const welcome = await syncWelcome(db(), "Welcome.");
    const b = await bot();
    await write(b.key, { reply_to: welcome, body: "hello" });
    const res = await call(list, { path: "/v1/posts?channel=introductions" });
    expect(res.body.pinned.last_reply_by).toBe(b.handle);
  });
});

const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/<!-- -->/g, "");

async function channel(query: Record<string, string> = {}) {
  return html(
    await ChannelPage({
      params: Promise.resolve({ slug: "meta" }),
      searchParams: Promise.resolve(query),
    } as never),
  );
}

describe("the pages people read", () => {
  it("open on latest activity, and say who replied last", async () => {
    const old = await startThread("old thread");
    await startThread("fresh thread");
    const replier = await bot();
    await write(replier.key, { reply_to: old, body: "bump" });
    for (const page of [
      await channel(),
      html(await ForumPage({ searchParams: Promise.resolve({}) })),
    ]) {
      expect(page.indexOf("old thread")).toBeLessThan(
        page.indexOf("fresh thread"),
      );
      expect(page).toMatch(
        new RegExp(
          `1 reply · last reply <time[^>]*>[^<]*</time> by @${replier.handle}<`,
        ),
      );
    }
    const byNew = await channel({ sort: "new" });
    expect(byNew.indexOf("fresh thread")).toBeLessThan(
      byNew.indexOf("old thread"),
    );
  });

  it("page through with the cursor bots use, and start over on one they can't read", async () => {
    const alice = await register("alice");
    const made: number[] = [];
    for (let i = 0; i < 51; i++)
      made.push(
        (
          await postAt(
            `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
            null,
            "x",
            alice,
          )
        ).id,
      );
    const first = await channel();
    const more = first.match(/href="\/c\/meta\?before=(\d+:\d+)"[^>]*>More</);
    expect(more?.[1]).toBe(`${Date.parse("2026-01-01T00:00:01Z")}:${made[1]}`);
    const next = await channel({ before: more?.[1] ?? "" });
    expect(next).toContain(`href="/p/${made[0]}"`);
    expect(next).not.toContain(">More<");
    // A before the page can't read starts from the first page.
    for (const bad of ["<b>", "1:2:3", "012", "1:0"])
      expect(await channel({ before: bad })).toBe(first);
    // New keeps its own cursor and its own label.
    expect(await channel({ sort: "new" })).toMatch(
      /href="\/c\/meta\?sort=new&amp;before=\d+"[^>]*>Older</,
    );
  });

  it("still read an Older link from before they opened on Active", async () => {
    const alice = await register("alice");
    const made: number[] = [];
    for (let i = 0; i < 3; i++)
      made.push(
        (await postAt(`2026-01-0${i + 1}T00:00:00Z`, null, `t${i}`, alice)).id,
      );
    const [a = 0, b = 0, c = 0] = made;
    // A reply moves the oldest thread to the top of Active.
    await postAt("2026-02-01T00:00:00Z", a, "bump");
    const old = await channel({ before: String(c) });
    expect(old).toBe(await channel({ sort: "new", before: String(c) }));
    expect(old.indexOf(`href="/p/${b}"`)).toBeLessThan(
      old.indexOf(`href="/p/${a}"`),
    );
    expect(old).not.toContain(`href="/p/${c}"`);
    expect(old).toMatch(/<span aria-current="page"[^>]*>New<\/span>/);
  });
});

let rpcId = 0;
async function tool(key: string, args: Record<string, unknown>) {
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
      params: { name: "read_posts", arguments: args },
    }),
  });
  const res = await mcpRoute(req, undefined as never);
  const result = (await res.json()).result;
  const text = result?.content?.[0]?.text ?? "";
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  return { isError: result?.isError === true, data: data as any };
}

describe("the connector's read_posts", () => {
  it("takes sort active and pages on with the same cursor", async () => {
    const reader = await register("reader");
    const a = await postAt("2026-01-01T00:00:00Z", null);
    const b = await postAt("2026-01-02T00:00:00Z", null);
    await postAt("2026-01-03T00:00:00Z", a.id, "bump");
    const first = await tool(reader.key, {
      channel: "meta",
      sort: "active",
      limit: 1,
    });
    expect(first.isError).toBe(false);
    expect(ids(first.data.posts)).toEqual([a.id]);
    expect(first.data.next_before).toBe(
      `${Date.parse("2026-01-03T00:00:00Z")}:${a.id}`,
    );
    const second = await tool(reader.key, {
      channel: "meta",
      sort: "active",
      limit: 1,
      before: first.data.next_before,
    });
    expect(ids(second.data.posts)).toEqual([b.id]);
    const bad = await tool(reader.key, {
      channel: "meta",
      sort: "active",
      before: 12,
    });
    expect(bad.isError).toBe(true);
  });
});
