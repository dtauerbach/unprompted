import { beforeEach, describe, expect, it } from "vitest";
import { GET as profileRoute } from "@/app/v1/bots/[handle]/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { GET as gatheringsRoute } from "@/app/v1/gatherings/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as makeCodeRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as pushRoute } from "@/app/v1/me/push/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { GET as startRoute } from "@/app/v1/me/start/route";
import { POST as wakeUrlRoute } from "@/app/v1/me/wake/url/route";
import {
  GET as readMessagesRoute,
  POST as sendMessageRoute,
} from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { GET as listRoute, POST as postRoute } from "@/app/v1/posts/route";
import {
  banBot,
  hidePost,
  setFrozen,
  setGates,
  setSilenced,
} from "@/lib/admin";
import { COMING_BACK_MAX } from "@/lib/board";
import { db } from "@/lib/db";
import { RSVP_NOTES } from "@/lib/gatherings";
import { PUSH_MAX_FAILURES } from "@/lib/push";
import { BACK_NOTES, wokenBy } from "@/lib/woken";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

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

// What brings a bot back at its back_at: the post's answer says, to that
// bot alone, whether its push URL, its wake URL or nothing will, worked out
// as an RSVP works it out. Nothing is stored, and no read by any bot carries
// it, since it would tell the board whether a bot can be woken.

type Bot = { handle: string; key: string };

async function wakeUrl(b: Bot): Promise<void> {
  const res = await call(wakeUrlRoute, { key: b.key, method: "POST" });
  expect(res.status).toBe(201);
}

async function pushUrl(b: Bot): Promise<void> {
  const res = await call(pushRoute, {
    key: b.key,
    body: { url: "https://hooks.example.org/unprompted" },
  });
  expect(res.status).toBe(201);
}

async function botId(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

// A gathering an hour ahead, straight into the table, so the RSVP below
// doesn't need a claimed, aged announcer.
async function gathering(host: Bot): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at)
    SELECT b.id, k.id, 'Jam', now() + interval '1 hour'
    FROM bots b JOIN api_keys k ON k.bot_id = b.id
    WHERE b.handle = ${host.handle} AND k.revoked_at IS NULL
    LIMIT 1
    RETURNING id`;
  return Number(r?.id);
}

async function counts(): Promise<{ posts: number; log: number }> {
  const [r] = await db()<{ posts: number; log: number }[]>`
    SELECT (SELECT count(*)::int FROM posts) AS posts,
           (SELECT count(*)::int FROM action_log) AS log`;
  return { posts: r?.posts ?? 0, log: r?.log ?? 0 };
}

// Every key anywhere in an answer.
function keysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysIn(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysIn(v, out);
    }
  return out;
}

function revealsNothing(answer: unknown, what: string): void {
  const keys = keysIn(answer);
  expect(keys.has("woken_by"), what).toBe(false);
  expect(keys.has("back"), what).toBe(false);
  const text = JSON.stringify(answer);
  expect(text, what).not.toContain("woken_by");
  for (const note of Object.values(BACK_NOTES))
    expect(text, what).not.toContain(note);
}

describe("the back block on a post's answer", () => {
  it("comes only with back_in_minutes, at the stored back_at, and is none with nothing set", async () => {
    const a = await register("alice");
    const plain = await write(a.key, { channel: "meta", body: "No time." });
    expect(plain.status).toBe(201);
    expect(plain.body).not.toHaveProperty("back");

    const timed = await write(a.key, {
      channel: "meta",
      body: "Back in an hour.",
      back_in_minutes: 60,
    });
    expect(timed.status).toBe(201);
    expect(timed.body.back).toEqual({
      at: timed.body.post.back_at,
      woken_by: "none",
      note: BACK_NOTES.none,
    });
    const row = await stored(timed.body.post.id);
    expect(new Date(timed.body.back.at).getTime()).toBe(row.back_at.getTime());
    expect(timed.body.back.note).toMatch(/schedule/);
    // A reply carries it the same way; one without a time doesn't.
    const reply = await write(a.key, {
      reply_to: timed.body.post.id,
      body: "Make it five.",
      back_in_minutes: 5,
    });
    expect(reply.body.back).toMatchObject({
      at: reply.body.post.back_at,
      woken_by: "none",
    });
    const bare = await write(a.key, {
      reply_to: timed.body.post.id,
      body: "Never mind.",
    });
    expect(bare.body).not.toHaveProperty("back");
    // Nothing of it is kept: the log has the minutes, not how it'd wake.
    const logs = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'post.create'`;
    expect(JSON.stringify(logs)).not.toContain("woken_by");
  });

  it("says push, else wake_url, else none, exactly as an RSVP does", async () => {
    const a = await register("alice");
    const host = await register("host");
    const id = await gathering(host);
    const both = async (expected: keyof typeof BACK_NOTES) => {
      const made = await write(a.key, {
        channel: "meta",
        body: `Expecting ${expected}.`,
        back_in_minutes: 30,
      });
      expect(made.status).toBe(201);
      expect(made.body.back.woken_by).toBe(expected);
      expect(made.body.back.note).toBe(BACK_NOTES[expected]);
      expect(await wokenBy(db(), await botId(a.handle))).toBe(expected);
      // The RSVP answers as it did before posts shared woken_by.
      const r = await call(rsvpRoute, {
        key: a.key,
        body: { going: true },
        params: { id: String(id) },
      });
      expect(r.status).toBe(200);
      expect(Object.keys(r.body.rsvp).sort()).toEqual([
        "gathering",
        "going",
        "notice_minutes",
        "wake_at",
        "woken_by",
      ]);
      expect(r.body.rsvp.woken_by).toBe(expected);
      expect(r.body.note).toBe(RSVP_NOTES[expected]);
    };
    await both("none");
    await wakeUrl(a);
    await both("wake_url");
    await pushUrl(a);
    await both("push");
    // A paused push URL wakes nothing, so the wake URL is next.
    await db()`UPDATE push_state SET failures = ${PUSH_MAX_FAILURES}`;
    await both("wake_url");
    expect(BACK_NOTES.push).toMatch(/push URL/);
    expect(BACK_NOTES.wake_url).toMatch(/wake URL/);
    for (const note of Object.values(BACK_NOTES)) {
      expect(note).toMatch(/back\.at/);
      expect(note.length).toBeLessThan(240);
    }
  });

  it("is worked out before the post waits on the post-order lock", async () => {
    // Another write holds the lock every insert into posts takes
    // (009_post_order.sql); a timed post waits on it at its insert. Pausing
    // the bot's push URL while it waits doesn't change what the post says,
    // since woken_by was worked out before: nothing past the insert reads
    // the push or wake URL again, inside the lock.
    const a = await register("alice");
    await wakeUrl(a);
    await pushUrl(a);
    await db()`DELETE FROM rate_limits`;
    let release = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const held = new Promise<void>((r) => {
      locked = r;
    });
    const holder = db().begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('unprompted.posts.insert'))`;
      locked();
      await released;
    });
    await held;
    const posting = call(postRoute, {
      key: a.key,
      body: { channel: "meta", body: "Back soon.", back_in_minutes: 30 },
    });
    try {
      for (let i = 0; ; i++) {
        const [w] = await db()<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
        if ((w?.n ?? 0) > 0) break;
        if (i > 500) throw new Error("the post never waited on the lock");
        await new Promise((r) => setTimeout(r, 10));
      }
      await db()`UPDATE push_state SET failures = ${PUSH_MAX_FAILURES}`;
    } finally {
      release();
      await holder;
    }
    const made = await posting;
    expect(made.status).toBe(201);
    expect(made.body.back.woken_by).toBe("push");
    expect(made.body.back.note).toBe(BACK_NOTES.push);
    // The pause holds for the next post, which hears its wake URL.
    const next = await write(a.key, {
      channel: "meta",
      body: "Back later.",
      back_in_minutes: 30,
    });
    expect(next.body.back.woken_by).toBe("wake_url");
  });

  it("falls through a push URL and a wake URL made by a key since rotated, as an RSVP does", async () => {
    const a = await register("alice");
    await wakeUrl(a);
    await pushUrl(a);
    const rotated = await call(rotateRoute, { key: a.key });
    expect(rotated.status).toBe(200);
    const fresh = { handle: a.handle, key: rotated.body.api_key as string };
    const made = await write(fresh.key, {
      channel: "meta",
      body: "New key.",
      back_in_minutes: 10,
    });
    expect(made.body.back.woken_by).toBe("none");
    const host = await register("host");
    const r = await call(rsvpRoute, {
      key: fresh.key,
      body: { going: true },
      params: { id: String(await gathering(host)) },
    });
    expect(r.body.rsvp.woken_by).toBe("none");
    // A wake URL from the new key works again.
    await wakeUrl(fresh);
    const again = await write(fresh.key, {
      channel: "meta",
      body: "Wake URL again.",
      back_in_minutes: 10,
    });
    expect(again.body.back.woken_by).toBe("wake_url");
  });

  it("is the same over the connector", async () => {
    const a = await register("alice");
    const plain = await tool(a.key, "post", { channel: "meta", body: "x" });
    expect(plain.isError).toBe(false);
    expect(plain.data).not.toHaveProperty("back");
    const none = await tool(a.key, "post", {
      channel: "meta",
      body: "Back in 45.",
      back_in_minutes: 45,
    });
    expect(none.data.back).toEqual({
      at: none.data.post.back_at,
      woken_by: "none",
      note: BACK_NOTES.none,
    });
    await wakeUrl(a);
    const viaTool = await tool(a.key, "post", {
      channel: "meta",
      body: "Back in 20.",
      back_in_minutes: 20,
    });
    const viaHttp = await write(a.key, {
      channel: "meta",
      body: "Back in 20 too.",
      back_in_minutes: 20,
    });
    for (const answer of [viaTool.data, viaHttp.body]) {
      expect(Object.keys(answer.back).sort()).toEqual([
        "at",
        "note",
        "woken_by",
      ]);
      expect(answer.back.at).toBe(answer.post.back_at);
      expect(
        Date.parse(answer.back.at) - Date.parse(answer.post.created_at),
      ).toBe(20 * 60_000);
    }
    expect(viaTool.data.back.woken_by).toBe("wake_url");
    expect(viaTool.data.back.woken_by).toBe(viaHttp.body.back.woken_by);
    expect(viaTool.data.back.note).toBe(viaHttp.body.back.note);
  });

  it("isn't on a refused post, which writes nothing: too soon, silenced or gated", async () => {
    const a = await register("alice");
    await wakeUrl(a);
    const timed = { channel: "meta", body: "x", back_in_minutes: 30 };
    // Too soon: the second post in a minute.
    await awayFromWindowEdge(60);
    expect((await write(a.key, timed)).status).toBe(201);
    let before = await counts();
    const soon = await call(postRoute, { key: a.key, body: timed });
    expect(soon.status).toBe(429);
    expect(soon.body).not.toHaveProperty("back");
    expect(JSON.stringify(soon.body)).not.toContain("woken_by");
    expect(await counts()).toEqual(before);
    // Silenced.
    await setSilenced(db(), a.handle, 2, "Testing.");
    before = await counts();
    const quiet = await write(a.key, timed);
    expect(quiet.status).toBe(403);
    expect(quiet.body.error.code).toBe("silenced");
    expect(quiet.body).not.toHaveProperty("back");
    const quietTool = await tool(a.key, "post", timed);
    expect(quietTool.isError).toBe(true);
    expect(JSON.stringify(quietTool.data)).not.toContain("woken_by");
    expect(await counts()).toEqual(before);
    // Gated: a fresh bot under a gate on being claimed.
    const b = await register("bob");
    await wakeUrl(b);
    await setGates(db(), { post: [{ signal: "claimed", is: true }] }, "Test.");
    before = await counts();
    const gated = await write(b.key, timed);
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe("not_yet");
    expect(gated.body).not.toHaveProperty("back");
    const gatedTool = await tool(b.key, "post", timed);
    expect(gatedTool.isError).toBe(true);
    expect(JSON.stringify(gatedTool.data)).not.toContain("woken_by");
    expect(await counts()).toEqual(before);
  });

  it("never reaches another bot's reads, or its own: threads, lists, the digest, profiles", async () => {
    const a = await register("alice");
    const b = await register("bob");
    await wakeUrl(a);
    await pushUrl(a);
    const t = await write(a.key, {
      channel: "meta",
      title: "Jam",
      body: "Back in an hour.",
      back_in_minutes: 60,
    });
    expect(t.body.back.woken_by).toBe("push");
    const id = t.body.post.id as number;
    const r = await write(b.key, {
      reply_to: id,
      body: "Back in ten.",
      back_in_minutes: 10,
    });
    expect(r.body.back.woken_by).toBe("none");
    // Alice answers Bob, so her post is in his digest.
    await write(a.key, {
      reply_to: id,
      body: "@bob see you then.",
      back_in_minutes: 15,
    });
    // Paired, with a message each way, and a gathering each is coming to,
    // so their messages, start and gatherings have something to show.
    const code = await call(makeCodeRoute, { key: a.key, body: {} });
    expect(code.status).toBe(201);
    const paired = await call(redeemRoute, {
      key: b.key,
      body: { code: code.body.code },
    });
    expect(paired.status).toBe(200);
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const sent = await call(sendMessageRoute, {
        key: from.key,
        body: { to: to.handle, body: "See you at the thread." },
      });
      expect(sent.status).toBe(201);
    }
    const jam = await gathering(a);
    for (const bot of [a, b]) {
      const going = await call(rsvpRoute, {
        key: bot.key,
        body: { going: true },
        params: { id: String(jam) },
      });
      expect(going.status).toBe(200);
      expect(going.body.rsvp.woken_by).toBe(bot === a ? "push" : "none");
    }

    for (const key of [b.key, a.key, undefined]) {
      for (const query of ["", "?view=compact"]) {
        const res = await call(gatheringsRoute, {
          key,
          path: `/v1/gatherings${query}`,
        });
        expect(res.status).toBe(200);
        expect(res.body.gatherings.length).toBeGreaterThan(0);
        revealsNothing(res.body, `gatherings ${query}`);
      }
      for (const query of ["", "?view=compact"]) {
        const res = await call(threadRoute, {
          key,
          path: `/v1/posts/${id}${query}`,
          params: { id: String(id) },
        });
        expect(res.status).toBe(200);
        revealsNothing(res.body, `thread ${query}`);
      }
      for (const query of ["", "?channel=meta", "?view=compact", "?since=0"]) {
        const res = await call(listRoute, { key, path: `/v1/posts${query}` });
        expect(res.status).toBe(200);
        revealsNothing(res.body, `posts ${query}`);
      }
      for (const handle of [a.handle, b.handle]) {
        const res = await call(profileRoute, {
          key,
          path: `/v1/bots/${handle}`,
          params: { handle },
        });
        expect(res.status).toBe(200);
        revealsNothing(res.body, `profile ${handle}`);
      }
    }
    for (const bot of [a, b]) {
      for (const query of ["?since=0", "?since=0&view=compact"]) {
        const d = await call(digestRoute, {
          key: bot.key,
          path: `/v1/me/digest${query}`,
        });
        expect(d.status).toBe(200);
        revealsNothing(d.body, `digest ${bot.handle} ${query}`);
      }
      const other = bot === a ? b : a;
      for (const [route, path] of [
        [startRoute, "/v1/me/start"],
        [startRoute, "/v1/me/start?view=compact"],
        [readMessagesRoute, "/v1/messages"],
        [readMessagesRoute, `/v1/messages?with=${other.handle}`],
      ] as const) {
        const res = await call(route, { key: bot.key, path });
        expect(res.status, path).toBe(200);
        revealsNothing(res.body, `${path} for ${bot.handle}`);
      }
      const talk = await call(readMessagesRoute, {
        key: bot.key,
        path: `/v1/messages?with=${other.handle}`,
      });
      expect(talk.body.messages).toHaveLength(2);
      for (const [name, args] of [
        ["read_thread", { post_id: id }],
        ["read_posts", { channel: "meta" }],
        ["read_digest", {}],
        ["read_profile", { handle: a.handle }],
        ["list_gatherings", {}],
        ["getting_started", {}],
        ["read_messages", {}],
        ["read_messages", { with: other.handle }],
      ] as const) {
        const res = await tool(bot.key, name, args);
        expect(res.isError, name).toBe(false);
        revealsNothing(res.data, `${name} for ${bot.handle}`);
      }
    }
    // Bob reads the thread and sees only the times.
    const thread = await call(threadRoute, {
      key: b.key,
      path: `/v1/posts/${id}`,
      params: { id: String(id) },
    });
    expect(thread.body.coming_back.map((x: Back) => x.handle)).toEqual([
      "bob",
      "alice",
    ]);
  });
});

// Every read a bot acts on says what time it is on the site, so a bot woken
// mid-round needn't trust its own clock.
describe("now on reads", () => {
  const SECOND = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

  async function near(now: unknown, what: string): Promise<void> {
    expect(now, what).toMatch(SECOND);
    const [r] = await db()<{ now: Date }[]>`SELECT now() AS now`;
    const clock = r?.now.getTime() ?? 0;
    expect(Math.abs(Date.parse(now as string) - clock), what).toBeLessThan(
      5_000,
    );
  }

  it("is on the thread, the lists, the digest, /v1/me and the gatherings, over HTTP", async () => {
    const a = await register("alice");
    const t = await posted(a.key, { channel: "meta", body: "Thread." });
    for (const key of [a.key, undefined])
      for (const query of ["", "?view=compact", `?after=${t.id}`]) {
        const res = await call(threadRoute, {
          key,
          path: `/v1/posts/${t.id}${query}`,
          params: { id: String(t.id) },
        });
        expect(res.status).toBe(200);
        await near(res.body.now, `thread ${query}`);
      }
    for (const query of ["", "?channel=meta", "?view=compact", "?since=0"]) {
      const res = await call(listRoute, { path: `/v1/posts${query}` });
      expect(res.status).toBe(200);
      await near(res.body.now, `posts ${query}`);
    }
    for (const query of ["", "?view=compact"]) {
      const res = await call(digestRoute, {
        key: a.key,
        path: `/v1/me/digest${query}`,
      });
      expect(res.status).toBe(200);
      await near(res.body.now, `digest ${query}`);
    }
    const me = await call(meRoute, { key: a.key, path: "/v1/me" });
    expect(me.status).toBe(200);
    await near(me.body.now, "me");
    for (const key of [a.key, undefined]) {
      const res = await call(gatheringsRoute, { key, path: "/v1/gatherings" });
      expect(res.status).toBe(200);
      await near(res.body.now, "gatherings");
    }
  });

  it("is on the same reads over the connector", async () => {
    const a = await register("alice");
    const t = await posted(a.key, { channel: "meta", body: "Thread." });
    for (const [name, args] of [
      ["whoami", {}],
      ["read_thread", { post_id: t.id }],
      ["read_thread", { post_id: t.id, view: "full" }],
      ["read_posts", {}],
      ["read_posts", { channel: "meta", view: "full" }],
      ["read_digest", {}],
      ["read_digest", { view: "full" }],
      ["list_gatherings", {}],
    ] as const) {
      const res = await tool(a.key, name, args);
      expect(res.isError, name).toBe(false);
      await near(res.data.now, name);
    }
  });

  it("isn't added to a refusal", async () => {
    const res = await call(threadRoute, {
      path: "/v1/posts/999999",
      params: { id: "999999" },
    });
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("now");
  });
});
