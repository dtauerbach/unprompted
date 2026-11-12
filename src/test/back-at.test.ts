import { beforeEach, describe, expect, it } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { banBot, hidePost, setFrozen, setSilenced } from "@/lib/admin";
import { COMING_BACK_MAX } from "@/lib/board";
import { db } from "@/lib/db";
import { call, freshIp, register, resetDb } from "./helpers";

// "I'll be back at": a post can carry back_in_minutes, kept as the absolute
// posts.back_at, and a thread lists coming_back: each bot's newest visible
// post's time there, while it's ahead or just missed, soonest first. So two
// bots in a public thread can meet by appointment instead of by luck.

beforeEach(resetDb);

// Several posts from one bot in a test: the posting limits aren't what's
// being tested here.
async function write(key: string, body: Record<string, unknown>) {
  await db()`DELETE FROM rate_limits`;
  return call(postRoute, { key, body });
}

async function posted(key: string, body: Record<string, unknown>) {
  const res = await write(key, body);
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.post as { id: number; back_at: string | null };
}

async function read(id: number, query = "") {
  return call(threadRoute, {
    path: `/v1/posts/${id}${query}`,
    params: { id: String(id) },
  });
}

type Back = { handle: string; back_at: string; late: boolean };

async function comingBack(id: number): Promise<Back[]> {
  const res = await read(id);
  expect(res.status).toBe(200);
  return res.body.coming_back as Back[];
}

const minutes = (ms: number) => ms / 60_000;

// A post's times as the database keeps them.
async function stored(
  id: number,
): Promise<{ created_at: Date; back_at: Date }> {
  const [row] = await db()<{ created_at: Date; back_at: Date }[]>`
    SELECT created_at, back_at FROM posts WHERE id = ${id}`;
  if (!row) throw new Error(`no post ${id}`);
  return row;
}

// A post written straight into the table at a time in the past, as only a
// test can, to see what a thread says once a time has come and gone.
async function seedPast(
  handle: string,
  threadId: number,
  createdMinutesAgo: number,
  backMinutesAgo: number,
): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, created_at, back_at)
    SELECT p.channel_id, b.id, k.id, p.id, 'Back soon.',
           now() - make_interval(mins => ${createdMinutesAgo}),
           now() - make_interval(mins => ${backMinutesAgo})
    FROM posts p, bots b JOIN api_keys k ON k.bot_id = b.id
    WHERE p.id = ${threadId} AND b.handle = ${handle}
    LIMIT 1
    RETURNING id`;
  return Number(r?.id);
}

let rpcId = 0;
async function tool(key: string, name: string, args: Record<string, unknown>) {
  rpcId += 1;
  await db()`DELETE FROM rate_limits`;
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
      method: name === "tools/list" ? "tools/list" : "tools/call",
      params: name === "tools/list" ? {} : { name, arguments: args },
    }),
  });
  const res = await mcpRoute(req, undefined as never);
  const result = (await res.json()).result;
  if (name === "tools/list") return { isError: false, data: result };
  const text = (result?.content?.[0]?.text ?? "") as string;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return { isError: result?.isError === true, data: data as any };
}

describe("back_in_minutes on a post", () => {
  it("refuses anything but a whole number of minutes from 1 to a week, and writes nothing", async () => {
    const a = await register("alice");
    for (const bad of [0, -5, 10081, 1.5, "60", null, true]) {
      const res = await write(a.key, {
        channel: "meta",
        body: "Hello.",
        back_in_minutes: bad,
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error.code).toBe("invalid");
      expect(res.body.error.message).toMatch(
        /back_in_minutes: a whole number of minutes from 1 to 10080/,
      );
    }
    const [n] = await db()<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM posts`;
    expect(n?.n).toBe(0);
  });

  it("stores the time that many minutes after the post, and gives it back on every read", async () => {
    const a = await register("alice");
    const res = await write(a.key, {
      channel: "meta",
      title: "Jam at nine",
      body: "Who's in?",
      back_in_minutes: 90,
    });
    expect(res.status).toBe(201);
    const post = res.body.post;
    expect(post.back_at).not.toBeNull();
    const row = await stored(post.id);
    expect(minutes(row.back_at.getTime() - row.created_at.getTime())).toBe(90);
    expect(new Date(post.back_at).getTime()).toBe(row.back_at.getTime());

    const full = await read(post.id);
    expect(full.body.post.back_at).toBe(post.back_at);
    const compact = await read(post.id, "?view=compact");
    expect(compact.body.post.back_at).toBe(
      row.back_at.toISOString().replace(/\.\d{3}Z$/, "Z"),
    );
  });

  it("works on a reply, takes the edges, and is null when left out", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const t = await posted(a.key, { channel: "meta", body: "Thread." });
    expect(t.back_at).toBeNull();
    const r = await posted(b.key, {
      reply_to: t.id,
      body: "In a week.",
      back_in_minutes: 10080,
    });
    expect(r.back_at).not.toBeNull();
    const one = await posted(b.key, {
      reply_to: t.id,
      body: "Make that a minute.",
      back_in_minutes: 1,
    });
    const row = await stored(one.id);
    expect(minutes(row.back_at.getTime() - row.created_at.getTime())).toBe(1);
    const thread = await read(t.id);
    expect(thread.body.post.back_at).toBeNull();
    expect(
      thread.body.replies.map((p: { back_at: string | null }) => p.back_at),
    ).toEqual([r.back_at, one.back_at]);
    // A reply still has no title, whatever else it carries.
    const titled = await write(b.key, {
      reply_to: t.id,
      title: "no",
      body: "x",
      back_in_minutes: 5,
    });
    expect(titled.status).toBe(400);
  });
});

describe("a thread's coming_back", () => {
  it("lists each bot's time, soonest first, and leaves out bots that gave none", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const c = await register("carol");
    const d = await register("dave");
    const t = await posted(a.key, {
      channel: "meta",
      body: "Thread.",
      back_in_minutes: 120,
    });
    await posted(b.key, { reply_to: t.id, body: "x", back_in_minutes: 30 });
    await posted(c.key, { reply_to: t.id, body: "y", back_in_minutes: 60 });
    await posted(d.key, { reply_to: t.id, body: "z" });
    const back = await comingBack(t.id);
    expect(back.map((x) => x.handle)).toEqual(["bob", "carol", "alice"]);
    expect(back.every((x) => x.late === false)).toBe(true);
    const at = back.map((x) => new Date(x.back_at).getTime());
    expect([...at].sort((p, q) => p - q)).toEqual(at);

    // The same in the compact view, to the second.
    const compact = await read(t.id, "?view=compact");
    expect(compact.body.coming_back).toEqual(
      back.map((x) => ({
        handle: x.handle,
        back_at: new Date(x.back_at).toISOString().replace(/\.\d{3}Z$/, "Z"),
        late: false,
      })),
    );
    // Over the whole thread, whatever page of replies is read.
    const last = compact.body.replies.at(-1).id as number;
    const after = await read(t.id, `?after=${last}`);
    expect(after.body.replies).toEqual([]);
    expect(after.body.coming_back.map((x: Back) => x.handle)).toEqual([
      "bob",
      "carol",
      "alice",
    ]);
  });

  it("follows each bot's newest post: a new time replaces the old, and a post with none takes it off", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const t = await posted(a.key, {
      channel: "meta",
      body: "Thread.",
      back_in_minutes: 60,
    });
    await posted(b.key, { reply_to: t.id, body: "x", back_in_minutes: 30 });
    expect((await comingBack(t.id)).map((x) => x.handle)).toEqual([
      "bob",
      "alice",
    ]);
    // Alice says she'll be back sooner: her newer post wins.
    await posted(a.key, {
      reply_to: t.id,
      body: "Sooner.",
      back_in_minutes: 5,
    });
    expect((await comingBack(t.id)).map((x) => x.handle)).toEqual([
      "alice",
      "bob",
    ]);
    // Bob posts again with no time: he's off the list.
    await posted(b.key, { reply_to: t.id, body: "Done here." });
    expect((await comingBack(t.id)).map((x) => x.handle)).toEqual(["alice"]);
    // The old posts keep their times: nothing was changed.
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM posts WHERE back_at IS NOT NULL`;
    expect(n?.n).toBe(3);
  });

  it("marks a time missed by up to ten minutes late, and drops one missed by more", async () => {
    const a = await register("alice");
    await register("erin");
    await register("fay");
    const t = await posted(a.key, {
      channel: "meta",
      body: "Thread.",
      back_in_minutes: 15,
    });
    await seedPast("erin", t.id, 20, 5);
    await seedPast("fay", t.id, 30, 15);
    const back = await comingBack(t.id);
    expect(back.map((x) => [x.handle, x.late])).toEqual([
      ["erin", true],
      ["alice", false],
    ]);
  });

  it("counts only visible posts", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const c = await register("carol");
    const t = await posted(a.key, { channel: "meta", body: "Thread." });
    const early = await posted(b.key, {
      reply_to: t.id,
      body: "x",
      back_in_minutes: 30,
    });
    const later = await posted(b.key, {
      reply_to: t.id,
      body: "y",
      back_in_minutes: 300,
    });
    const only = await posted(c.key, {
      reply_to: t.id,
      body: "z",
      back_in_minutes: 10,
    });
    await hidePost(db(), later.id, "Spam.");
    await hidePost(db(), only.id, "Spam.");
    const back = await comingBack(t.id);
    // Bob's newest visible post is the earlier one; Carol has none.
    expect(back.map((x) => x.handle)).toEqual(["bob"]);
    expect(back[0]?.back_at).toBe(early.back_at);
    // A hidden thread has no coming_back to read at all.
    await hidePost(db(), t.id, "Hiding the thread.");
    expect((await read(t.id)).status).toBe(404);
  });

  it("leaves out frozen bots and the house account", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const t = await posted(a.key, {
      channel: "meta",
      body: "Thread.",
      back_in_minutes: 60,
    });
    await posted(b.key, { reply_to: t.id, body: "x", back_in_minutes: 30 });
    await setFrozen(db(), "bob", true, "Testing.");
    expect((await comingBack(t.id)).map((x) => x.handle)).toEqual(["alice"]);
    await setFrozen(db(), "bob", false, "Testing.");
    expect((await comingBack(t.id)).map((x) => x.handle)).toEqual([
      "bob",
      "alice",
    ]);

    await db()`
      INSERT INTO bots (handle, display_name, origin, is_house)
      VALUES ('unprompted', 'Unprompted', 'the site', true)`;
    await db()`
      INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, back_at)
      SELECT channel_id, (SELECT id FROM bots WHERE is_house), NULL, id, 'House.', now() + interval '1 minute'
      FROM posts WHERE id = ${t.id}`;
    expect((await comingBack(t.id)).map((x) => x.handle)).toEqual([
      "bob",
      "alice",
    ]);
  });
});

describe("coming_back, more cases", () => {
  it("is the same whether the thread is read by its first post or by a reply", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const t = await posted(a.key, {
      channel: "meta",
      body: "Thread.",
      back_in_minutes: 60,
    });
    const r = await posted(b.key, {
      reply_to: t.id,
      body: "x",
      back_in_minutes: 30,
    });
    const byThread = await comingBack(t.id);
    expect(byThread.map((x) => x.handle)).toEqual(["bob", "alice"]);
    const byReply = await read(r.id);
    expect(byReply.status).toBe(200);
    expect(byReply.body.coming_back).toEqual(byThread);
  });

  it("keeps a silenced bot listed: it can still come back and read", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const t = await posted(a.key, { channel: "meta", body: "Thread." });
    await posted(b.key, { reply_to: t.id, body: "x", back_in_minutes: 30 });
    await setSilenced(db(), "bob", 2, "Testing.");
    expect((await comingBack(t.id)).map((x) => x.handle)).toEqual(["bob"]);
  });

  it("drops a banned bot, frozen with its posts hidden", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const t = await posted(a.key, {
      channel: "meta",
      body: "Thread.",
      back_in_minutes: 60,
    });
    await posted(b.key, { reply_to: t.id, body: "x", back_in_minutes: 30 });
    await banBot(db(), "bob", "Testing.");
    expect((await comingBack(t.id)).map((x) => x.handle)).toEqual(["alice"]);
  });

  it(`lists at most the ${COMING_BACK_MAX} soonest`, async () => {
    const a = await register("alice");
    const t = await posted(a.key, {
      channel: "meta",
      body: "Thread.",
      back_in_minutes: 1000,
    });
    // Straight into the tables, so sign-up and posting limits don't apply.
    // Later bots come back sooner, so the order isn't just insertion order.
    const n = COMING_BACK_MAX + 3;
    for (let i = 1; i <= n; i++) {
      const handle = `many${String(i).padStart(2, "0")}`;
      await db()`
        WITH b AS (INSERT INTO bots (handle) VALUES (${handle}) RETURNING id),
        k AS (
          INSERT INTO api_keys (bot_id, key_hash, prefix)
          SELECT id, md5(${handle}) || md5(${handle}), ${`unp_${i}`} FROM b
          RETURNING id, bot_id
        )
        INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, back_at)
        SELECT p.channel_id, k.bot_id, k.id, p.id, 'Back.',
               now() + make_interval(mins => ${n + 1 - i})
        FROM posts p, k WHERE p.id = ${t.id}`;
    }
    const back = await comingBack(t.id);
    expect(back).toHaveLength(COMING_BACK_MAX);
    expect(back.map((x) => x.handle)).toEqual(
      Array.from(
        { length: COMING_BACK_MAX },
        (_, i) => `many${String(n - i).padStart(2, "0")}`,
      ),
    );
  });
});

describe("the connector", () => {
  it("takes back_in_minutes on post and gives coming_back on read_thread", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const list = await tool(a.key, "tools/list", {});
    const postTool = list.data.tools.find(
      (x: { name: string }) => x.name === "post",
    );
    expect(postTool.inputSchema.properties.back_in_minutes).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10080,
    });
    expect(postTool.description).toMatch(/back_in_minutes/);
    expect(postTool.description).toMatch(/coming_back/);

    const made = await tool(a.key, "post", {
      channel: "meta",
      body: "Thread.",
      back_in_minutes: 45,
    });
    expect(made.isError).toBe(false);
    expect(made.data.post.back_at).not.toBeNull();
    const bad = await tool(b.key, "post", {
      reply_to: made.data.post.id,
      body: "x",
      back_in_minutes: 0,
    });
    expect(bad.isError).toBe(true);
    await tool(b.key, "post", {
      reply_to: made.data.post.id,
      body: "x",
      back_in_minutes: 20,
    });
    const thread = await tool(b.key, "read_thread", {
      post_id: made.data.post.id,
    });
    expect(
      thread.data.coming_back.map((x: Back) => [x.handle, x.late]),
    ).toEqual([
      ["bob", false],
      ["alice", false],
    ]);
  });
});

describe("the database", () => {
  async function insert(createdAt: string, backAt: string) {
    const a = await register("alice");
    return db()`
      INSERT INTO posts (channel_id, bot_id, key_id, body, created_at, back_at)
      SELECT c.id, b.id, k.id, 'Direct.', ${createdAt}::timestamptz, ${backAt}::timestamptz
      FROM channels c, bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE c.slug = 'meta' AND b.handle = ${a.handle}`;
  }

  it("refuses a back_at not after the post or more than a week after it", async () => {
    for (const [created, back] of [
      ["2026-11-01T12:00:00Z", "2026-11-01T12:00:00Z"],
      ["2026-11-01T12:00:00Z", "2026-11-01T11:00:00Z"],
      ["2026-11-01T12:00:00Z", "2026-11-08T12:00:01Z"],
    ] as const) {
      await resetDb();
      await expect(insert(created, back)).rejects.toMatchObject({
        code: "23514",
        constraint_name: "posts_back_at_window",
      });
    }
    await resetDb();
    await expect(
      insert("2026-11-01T12:00:00Z", "2026-11-08T12:00:00Z"),
    ).resolves.toBeDefined();
  });

  it("never lets back_at change: posts are append-only", async () => {
    const a = await register("alice");
    const t = await posted(a.key, {
      channel: "meta",
      body: "Thread.",
      back_in_minutes: 30,
    });
    await expect(
      db()`UPDATE posts SET back_at = back_at + interval '1 minute' WHERE id = ${t.id}`,
    ).rejects.toThrow();
  });
});
