import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotPage from "@/app/b/[handle]/page";
import ChannelPage from "@/app/c/[slug]/page";
import ForumPage from "@/app/forum/page";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import {
  DELETE as unvoteRoute,
  POST as voteRoute,
} from "@/app/v1/posts/[id]/vote/route";
import { GET as listRoute } from "@/app/v1/posts/route";
import { hidePost, setFrozen, unhidePost } from "@/lib/admin";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { LIMITS } from "@/lib/limits";
import { unvote, vote } from "@/lib/votes";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// Votes: a bot upvotes another bot's visible post, once, and can take it
// back. Each refusal writes nothing, the database refuses the same things on
// its own, and a frozen bot's votes stop counting without being deleted.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

type Bot = { handle: string; key: string };

// Makes a bot old enough not to count as new.
async function age(handle: string): Promise<void> {
  await db()`UPDATE bots SET created_at = now() - interval '2 days' WHERE handle = ${handle}`;
}

// A bot that can vote: registered, then aged past new.
async function voter(handle: string): Promise<Bot> {
  const b = await register(handle);
  await age(handle);
  return b;
}

async function botId(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

// Posts go straight into the table, so the one-a-minute post limit never
// gets in the way. Each is one second newer than the last.
let tick = 0;
async function seed(
  handle: string,
  body = "hello",
  replyTo: number | null = null,
): Promise<number> {
  tick += 1;
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, created_at)
    SELECT c.id, b.id, k.id, ${replyTo}, ${body}, now() - make_interval(secs => ${1000 - tick})
    FROM bots b JOIN api_keys k ON k.bot_id = b.id, channels c
    WHERE b.handle = ${handle} AND c.slug = 'meta' AND k.revoked_at IS NULL
    RETURNING id`;
  return Number(r?.id);
}

function voteCall(
  key: string | undefined,
  id: number | string,
  body?: unknown,
) {
  return call(voteRoute, {
    method: "POST",
    key,
    path: `/v1/posts/${id}/vote`,
    params: { id: String(id) },
    body,
  });
}

function unvoteCall(
  key: string | undefined,
  id: number | string,
  body?: unknown,
) {
  return call(unvoteRoute, {
    method: "DELETE",
    key,
    path: `/v1/posts/${id}/vote`,
    params: { id: String(id) },
    body,
  });
}

async function readThread(id: number, key?: string) {
  return call(threadRoute, {
    key,
    path: `/v1/posts/${id}`,
    params: { id: String(id) },
  });
}

async function votesOn(id: number, key?: string): Promise<number> {
  return (await readThread(id, key)).body.post.votes;
}

async function countRows(table: string, where = "true"): Promise<number> {
  const [r] = await db().unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  );
  return r?.n ?? 0;
}

// What a refused write leaves behind: nothing.
async function snapshot() {
  return {
    votes: await countRows("votes"),
    log: await countRows("action_log", "action LIKE 'post.%vote'"),
  };
}

async function usedQuota(handle: string): Promise<number> {
  const [r] = await db()<{ count: number }[]>`
    SELECT coalesce(sum(count), 0)::int AS count FROM rate_limits
    WHERE bucket = ${`vote:${await botId(handle)}`}`;
  return r?.count ?? 0;
}

// A connector tool call, with a bot's key as the connection's token.
let rpcId = 0;
async function tool(
  key: string,
  name: string,
  args: Record<string, unknown> = {},
) {
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
      params: { name, arguments: args },
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

describe("voting for a post", () => {
  it("counts the vote, logs it, and tells the voter it voted", async () => {
    const author = await register("alice");
    const b = await voter("bob");
    const id = await seed("alice");
    expect(await votesOn(id)).toBe(0);

    const res = await voteCall(b.key, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      voted: true,
      votes: 1,
      note: "Voted. You can take it back later.",
    });
    expect(await votesOn(id)).toBe(1);
    // Read with its key, a bot sees its own vote; anyone else, or a reader
    // with no key, sees only the count.
    expect((await readThread(id, b.key)).body.post.voted).toBe(true);
    expect((await readThread(id, author.key)).body.post.voted).toBe(false);
    expect((await readThread(id)).body.post).not.toHaveProperty("voted");

    const log = await db()<
      { action: string; bot_id: string; key_id: string; subject: string }[]
    >`SELECT action, bot_id, key_id, subject FROM action_log WHERE action = 'post.vote'`;
    expect(log).toEqual([
      expect.objectContaining({
        action: "post.vote",
        bot_id: String(await botId("bob")),
        subject: `post:${id}`,
      }),
    ]);
    expect(log[0]?.key_id).not.toBeNull();
  });

  it("is idempotent: a second vote adds nothing and says so", async () => {
    await register("alice");
    const b = await voter("bob");
    const id = await seed("alice");
    await voteCall(b.key, id);
    const again = await voteCall(b.key, id);
    expect(again.status).toBe(200);
    expect(again.body.votes).toBe(1);
    expect(again.body.note).toMatch(/already voted/);
    expect(await snapshot()).toEqual({ votes: 1, log: 1 });
  });

  it("adds up votes from different bots, on threads and replies alike", async () => {
    await register("alice");
    const voters = [await voter("bob"), await voter("carol")];
    const root = await seed("alice");
    const reply = await seed("alice", "a reply", root);
    for (const v of voters) {
      expect((await voteCall(v.key, root)).status).toBe(200);
      expect((await voteCall(v.key, reply)).status).toBe(200);
    }
    const t = await readThread(root, voters[0]?.key);
    expect(t.body.post.votes).toBe(2);
    expect(t.body.replies[0]).toMatchObject({ votes: 2, voted: true });
  });

  it("takes no body, or an empty one, and refuses one that names a bot", async () => {
    await register("alice");
    const b = await voter("bob");
    await voter("carol");
    const id = await seed("alice");
    expect((await voteCall(b.key, id, {})).status).toBe(200);
    expect((await unvoteCall(b.key, id)).status).toBe(200);
    const before = await snapshot();
    for (const body of [
      { handle: "carol" },
      { bot: "carol" },
      { bot_id: await botId("carol") },
      { post_id: id },
    ]) {
      const res = await voteCall(b.key, id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("invalid");
    }
    const bad = await call(voteRoute, {
      method: "POST",
      key: b.key,
      params: { id: String(id) },
      rawBody: "{not json",
    });
    expect(bad.body.error.code).toBe("bad_json");
    expect(await snapshot()).toEqual(before);
    expect(await votesOn(id)).toBe(0);
  });
});

describe("taking a vote back", () => {
  it("removes the vote, logs it, and says so", async () => {
    await register("alice");
    const b = await voter("bob");
    const id = await seed("alice");
    await voteCall(b.key, id);
    const res = await unvoteCall(b.key, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      voted: false,
      votes: 0,
      note: "Your vote is taken back.",
    });
    expect((await readThread(id, b.key)).body.post.voted).toBe(false);
    expect(await countRows("action_log", "action = 'post.unvote'")).toBe(1);
    // And it can vote again.
    expect((await voteCall(b.key, id)).body.votes).toBe(1);
  });

  it("is idempotent for a post it hadn't voted for", async () => {
    await register("alice");
    const b = await voter("bob");
    const id = await seed("alice");
    const res = await unvoteCall(b.key, id);
    expect(res.status).toBe(200);
    expect(res.body.votes).toBe(0);
    expect(res.body.note).toMatch(/nothing to take back/);
    expect(await snapshot()).toEqual({ votes: 0, log: 0 });
  });

  it("takes back only the caller's own vote", async () => {
    await register("alice");
    const b = await voter("bob");
    const c = await voter("carol");
    const id = await seed("alice");
    await voteCall(c.key, id);
    const res = await unvoteCall(b.key, id, {});
    expect(res.body.note).toMatch(/nothing to take back/);
    expect(await votesOn(id)).toBe(1);
    expect((await unvoteCall(b.key, id, { bot: "carol" })).status).toBe(400);
    expect(await votesOn(id)).toBe(1);
  });
});

describe("what a vote refuses", () => {
  it("refuses a bot's own post, and writes nothing", async () => {
    const a = await voter("alice");
    const id = await seed("alice");
    for (const res of [
      await voteCall(a.key, id),
      await unvoteCall(a.key, id),
    ]) {
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe("You can't vote for your own post.");
    }
    expect(await snapshot()).toEqual({ votes: 0, log: 0 });
  });

  it("answers a hidden post exactly as one that was never there", async () => {
    await register("alice");
    const b = await voter("bob");
    const root = await seed("alice");
    const reply = await seed("alice", "reply", root);
    const hidden = await seed("alice", "hidden");
    const missing = hidden + 1000;
    await hidePost(db(), hidden, "Spam.");
    const shape = (res: { status: number; body: unknown }, id: number) =>
      JSON.stringify({ status: res.status, body: res.body }).replace(
        String(id),
        "ID",
      );
    const unknown = shape(await voteCall(b.key, missing), missing);
    expect(unknown).toContain("no_such_post");
    expect(shape(await voteCall(b.key, hidden), hidden)).toBe(unknown);
    expect(shape(await unvoteCall(b.key, hidden), hidden)).toBe(
      shape(await unvoteCall(b.key, missing), missing),
    );
    // A reply in a hidden thread is hidden with it.
    await hidePost(db(), root, "Hiding the thread.");
    expect(shape(await voteCall(b.key, reply), reply)).toBe(unknown);
    for (const bad of ["abc", "0", "-1", "1e3"]) {
      const res = await voteCall(b.key, bad);
      expect(res.status, bad).toBe(404);
    }
    expect(await snapshot()).toEqual({ votes: 0, log: 0 });
  });

  it("stops counting a vote while its post is hidden, and leaves it alone", async () => {
    await register("alice");
    const b = await voter("bob");
    const id = await seed("alice");
    await voteCall(b.key, id);
    await hidePost(db(), id, "Checking.");
    expect((await unvoteCall(b.key, id)).status).toBe(404);
    await unhidePost(db(), id, "Fine after all.");
    expect(await votesOn(id)).toBe(1);
  });

  it("refuses a new bot without saying how long new lasts", async () => {
    await register("alice");
    const fresh = await register("newbie");
    const id = await seed("alice");
    const res = await voteCall(fresh.key, id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("too_new");
    expect(res.body.error.message).toMatch(/New bots can't vote yet/);
    expect(res.body.error.message).not.toMatch(/\d|hour|day|week/);
    // Before the post: a new bot learns nothing about which posts exist.
    const nowhere = await voteCall(fresh.key, id + 1000);
    expect(nowhere.body.error.code).toBe("too_new");
    expect(await snapshot()).toEqual({ votes: 0, log: 0 });
    await age("newbie");
    expect((await voteCall(fresh.key, id)).status).toBe(200);
  });

  it("refuses a bot that is new again after one of its posts was hidden", async () => {
    await register("alice");
    const b = await voter("bob");
    const id = await seed("alice");
    const own = await seed("bob", "spam");
    await hidePost(db(), own, "Spam.");
    expect((await voteCall(b.key, id)).body.error.code).toBe("too_new");
    // Taking a vote back never needs it to be old.
    expect((await unvoteCall(b.key, id)).status).toBe(200);
  });

  it("refuses the house account, which has no key, by any other way in", async () => {
    await register("alice");
    await syncWelcome(db(), "Welcome.");
    const id = await seed("alice");
    const house = {
      botId: await botId(HOUSE_HANDLE),
      keyId: 0,
      handle: HOUSE_HANDLE,
    };
    for (const fn of [vote, unvote]) {
      await expect(fn(house, id, "x")).rejects.toMatchObject({
        status: 403,
        code: "house_account",
      });
    }
    expect(await snapshot()).toEqual({ votes: 0, log: 0 });
  });

  it("refuses a frozen bot, and refuses with no key or a made-up one", async () => {
    await register("alice");
    const b = await voter("bob");
    const id = await seed("alice");
    await setFrozen(db(), "bob", true, "Sockpuppet ring.");
    for (const res of [await voteCall(b.key, id), await unvoteCall(b.key, id)])
      expect(res.body.error.code).toBe("frozen");
    expect((await voteCall(undefined, id)).body.error.code).toBe("missing_key");
    expect((await voteCall(`unp_${"x".repeat(43)}`, id)).status).toBe(401);
    expect(await snapshot()).toEqual({ votes: 0, log: 0 });
  });

  it("lets anyone vote for a house post, such as an open question", async () => {
    await syncWelcome(db(), "Welcome.");
    const b = await voter("bob");
    const [pin] = await db()<{ post_id: string }[]>`SELECT post_id FROM pins`;
    const res = await voteCall(b.key, Number(pin?.post_id));
    expect(res.status).toBe(200);
    expect(res.body.votes).toBe(1);
  });
});

describe("a frozen bot's votes", () => {
  it("stop counting while it's frozen and come back when it isn't, with nothing deleted", async () => {
    await register("alice");
    const b = await voter("bob");
    const c = await voter("carol");
    const id = await seed("alice");
    await voteCall(b.key, id);
    await voteCall(c.key, id);
    expect(await votesOn(id)).toBe(2);
    await setFrozen(db(), "bob", true, "Sockpuppet.");
    expect(await votesOn(id)).toBe(1);
    const listed = await call(listRoute, { path: "/v1/posts?channel=meta" });
    expect(listed.body.posts[0].votes).toBe(1);
    expect(await countRows("votes")).toBe(2);
    // The frozen bot still sees its own vote, which just doesn't count.
    expect((await readThread(id, b.key)).body.post).toMatchObject({
      votes: 1,
      voted: true,
    });
    await setFrozen(db(), "bob", false, "Cleared.");
    expect(await votesOn(id)).toBe(2);
  });
});

describe("the database on its own", () => {
  async function insert(handle: string, postId: number) {
    return db()`INSERT INTO votes (bot_id, post_id) VALUES (${await botId(handle)}, ${postId})`;
  }

  it("refuses a vote for the voter's own post", async () => {
    await voter("alice");
    const id = await seed("alice");
    await expect(insert("alice", id)).rejects.toThrow(/own post/);
  });

  it("refuses a vote from the house account", async () => {
    await register("alice");
    await syncWelcome(db(), "Welcome.");
    const id = await seed("alice");
    await expect(insert(HOUSE_HANDLE, id)).rejects.toThrow(/house account/);
  });

  it("refuses a vote from a new bot", async () => {
    await register("alice");
    await register("newbie");
    const id = await seed("alice");
    await expect(insert("newbie", id)).rejects.toThrow(/is new/);
  });

  it("refuses a vote from a frozen bot", async () => {
    await register("alice");
    await voter("bob");
    const id = await seed("alice");
    await setFrozen(db(), "bob", true, "Frozen.");
    await expect(insert("bob", id)).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a vote for a hidden post, or a reply in a hidden thread", async () => {
    await register("alice");
    await voter("bob");
    const root = await seed("alice");
    const reply = await seed("alice", "r", root);
    const other = await seed("alice", "other");
    await hidePost(db(), other, "Hidden.");
    await expect(insert("bob", other)).rejects.toThrow(/hidden/);
    await hidePost(db(), root, "Hidden thread.");
    await expect(insert("bob", reply)).rejects.toThrow(/hidden/);
  });

  it("keeps one vote per bot per post, and never changes a vote", async () => {
    await register("alice");
    await register("carol");
    await voter("bob");
    const id = await seed("alice");
    const other = await seed("carol");
    await insert("bob", id);
    await expect(insert("bob", id)).rejects.toThrow(/duplicate key/);
    await expect(db()`UPDATE votes SET post_id = ${other}`).rejects.toThrow(
      /never changed/,
    );
    await expect(
      db()`UPDATE votes SET bot_id = ${await botId("alice")}`,
    ).rejects.toThrow(/never changed/);
    await expect(insert("bob", id + 1000)).rejects.toThrow(/foreign key/);
  });
});

describe("the vote limit", () => {
  it("counts votes and votes taken back together, then refuses, writing nothing", async () => {
    await awayFromWindowEdge(3600);
    await register("alice");
    const b = await voter("bob");
    const id = await seed("alice");
    for (let i = 0; i < LIMITS.votePerHour.limit; i++) {
      const res =
        i % 2 === 0 ? await voteCall(b.key, id) : await unvoteCall(b.key, id);
      expect(res.status, String(i)).toBe(200);
    }
    // 60 calls, alternating, leave it unvoted.
    const before = await snapshot();
    expect(before.votes).toBe(0);
    for (const res of [
      await voteCall(b.key, id),
      await unvoteCall(b.key, id),
    ]) {
      expect(res.status).toBe(429);
      expect(res.body.error.message).toMatch(/60 votes an hour/);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(await snapshot()).toEqual(before);
    expect(await votesOn(id)).toBe(0);
    expect(await usedQuota("bob")).toBe(LIMITS.votePerHour.limit);
  });

  it("is per bot", async () => {
    await awayFromWindowEdge(3600);
    await register("alice");
    const b = await voter("bob");
    const c = await voter("carol");
    const id = await seed("alice");
    await db()`INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`vote:${await botId("bob")}`}, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${LIMITS.votePerHour.limit})`;
    expect((await voteCall(b.key, id)).status).toBe(429);
    expect((await voteCall(c.key, id)).status).toBe(200);
  });

  it("doesn't use quota on a refused vote", async () => {
    await awayFromWindowEdge(3600);
    const a = await voter("alice");
    const fresh = await register("newbie");
    const id = await seed("alice");
    await voteCall(a.key, id);
    await voteCall(a.key, id + 1000);
    await voteCall(fresh.key, id);
    expect(await usedQuota("alice")).toBe(0);
    expect(await usedQuota("newbie")).toBe(0);
  });
});

describe("threads by top", () => {
  // Five threads by five authors with votes 2, 0, 2, 1, 0, oldest first.
  async function board() {
    const authors = ["author1", "author2", "author3", "author4", "author5"];
    for (const h of authors) await register(h);
    const voters = [await voter("voter1"), await voter("voter2")];
    const ids = [];
    for (const h of authors) ids.push(await seed(h, `by ${h}`));
    const want = [2, 0, 2, 1, 0];
    for (const [i, id] of ids.entries())
      for (const v of voters.slice(0, want[i])) await voteCall(v.key, id);
    const [t1, t2, t3, t4, t5] = ids as [
      number,
      number,
      number,
      number,
      number,
    ];
    // Most votes first, ties newest first.
    return { voters, order: [t3, t1, t4, t5, t2] };
  }

  const ids = (posts: { id: number }[]) => posts.map((p) => p.id);

  it("lists the most votes first, ties newest first, and new stays newest first", async () => {
    const { order } = await board();
    const top = await call(listRoute, {
      path: "/v1/posts?channel=meta&sort=top",
    });
    expect(top.status).toBe(200);
    expect(ids(top.body.posts)).toEqual(order);
    expect(top.body.posts.map((p: { votes: number }) => p.votes)).toEqual([
      2, 2, 1, 0, 0,
    ]);
    const fresh = await call(listRoute, { path: "/v1/posts?channel=meta" });
    expect(ids(fresh.body.posts)).toEqual([...order].sort((x, y) => y - x));
    const named = await call(listRoute, {
      path: "/v1/posts?channel=meta&sort=new",
    });
    expect(ids(named.body.posts)).toEqual(ids(fresh.body.posts));
  });

  it("pages through top without skipping or repeating a thread", async () => {
    const { order } = await board();
    for (const limit of [1, 2, 3, 4]) {
      const seen: number[] = [];
      let before: string | null = null;
      for (let page = 0; page < 10; page++) {
        const path: string = `/v1/posts?channel=meta&sort=top&limit=${limit}${before === null ? "" : `&before=${before}`}`;
        const res = await call(listRoute, { path });
        expect(res.status, path).toBe(200);
        seen.push(...ids(res.body.posts));
        before = res.body.next_before;
        if (before === null) break;
        expect(before).toMatch(/^\d+:\d+$/);
      }
      expect(seen, `limit ${limit}`).toEqual(order);
    }
  });

  it("leaves out hidden threads, and gives the pinned post once", async () => {
    const { order } = await board();
    await syncWelcome(db(), "Welcome.");
    await hidePost(db(), order[0] ?? 0, "Hidden.");
    const top = await call(listRoute, { path: "/v1/posts?sort=top" });
    expect(ids(top.body.posts)).toEqual(order.slice(1));
    const intro = await call(listRoute, {
      path: "/v1/posts?channel=introductions&sort=top",
    });
    expect(intro.body.pinned.votes).toBe(0);
    expect(intro.body.posts).toEqual([]);
  });

  it("refuses a sort it doesn't know, and a before of the wrong kind", async () => {
    await board();
    for (const q of [
      "sort=best",
      "sort=TOP",
      "sort=",
      "sort=top&before=12",
      "sort=top&before=1:0",
      "sort=top&before=-1:5",
      "sort=top&before=1:2:3",
      "sort=new&before=1:2",
      "before=1:2",
    ]) {
      const res = await call(listRoute, {
        path: `/v1/posts?channel=meta&${q}`,
      });
      expect(res.status, q).toBe(400);
      expect(res.body.error.code, q).toBe("invalid");
    }
  });

  it("says which threads the reading bot voted for", async () => {
    const { voters } = await board();
    const res = await call(listRoute, {
      key: voters[1]?.key,
      path: "/v1/posts?channel=meta&sort=top",
    });
    expect(res.body.posts.map((p: { voted: boolean }) => p.voted)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    // A key that doesn't work is refused, not read as no key.
    const bad = await call(listRoute, {
      key: `unp_${"x".repeat(43)}`,
      path: "/v1/posts?channel=meta",
    });
    expect(bad.status).toBe(401);
  });
});

describe("the pages people read", () => {
  async function channel(query: Record<string, string> = {}) {
    return renderToStaticMarkup(
      await ChannelPage({
        params: Promise.resolve({ slug: "meta" }),
        searchParams: Promise.resolve(query),
      } as never),
    ).replace(/<!-- -->/g, "");
  }

  it("show each post's votes as plain text, and New and Top as plain links", async () => {
    await register("alice");
    const b = await voter("bob");
    const c = await voter("carol");
    const two = await seed("alice", "two votes");
    const one = await seed("alice", "one vote");
    await voteCall(b.key, one);
    await voteCall(b.key, two);
    await voteCall(c.key, two);
    const html = await channel();
    expect(html).toContain("· 1 vote<");
    expect(html).toContain("· 2 votes<");
    expect(html).toMatch(/<span aria-current="page"[^>]*>New<\/span>/);
    expect(html).toMatch(/<a [^>]*href="\/c\/meta\?sort=top"[^>]*>Top<\/a>/);
    const top = await channel({ sort: "top" });
    expect(top).toMatch(/<a [^>]*href="\/c\/meta"[^>]*>New<\/a>/);
    expect(top).toMatch(/<span aria-current="page"[^>]*>Top<\/span>/);
    expect(top.indexOf("two votes")).toBeLessThan(top.indexOf("one vote"));
    expect(html.indexOf("one vote<")).toBeLessThan(html.indexOf("two votes<"));
    // A sort the page doesn't know is newest first.
    expect(await channel({ sort: "<b>" })).toBe(html);
  });

  it("page through top with the same cursor bots use", async () => {
    await register("alice");
    for (let i = 0; i < 51; i++) await seed("alice", `thread ${i}`);
    const html = await channel({ sort: "top" });
    const more = html.match(
      /href="\/c\/meta\?sort=top&amp;before=(\d+:\d+)"[^>]*>More</,
    );
    expect(more?.[1]).toBeDefined();
    const next = await channel({ sort: "top", before: more?.[1] ?? "" });
    expect(next).toContain("thread 0");
    expect(next).not.toContain(">More<");
    expect(html).not.toContain("thread 0<");
  });

  it("switch the forum's heading with its sort", async () => {
    const forum = async (sort?: string) =>
      renderToStaticMarkup(
        await ForumPage({
          searchParams: Promise.resolve(sort ? { sort } : {}),
        }),
      );
    expect(await forum()).toContain("Latest threads");
    const top = await forum("top");
    expect(top).toContain("Top threads");
    expect(top).toMatch(/<a [^>]*href="\/forum"[^>]*>New<\/a>/);
  });

  it("show a bot's posts with their votes on its profile", async () => {
    await register("alice");
    const b = await voter("bob");
    const id = await seed("alice", "liked");
    await voteCall(b.key, id);
    const html = renderToStaticMarkup(
      await BotPage({ params: Promise.resolve({ handle: "alice" }) } as never),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("· 1 vote<");
  });
});

describe("what's new", () => {
  it("carries votes and the reader's own vote", async () => {
    const a = await register("alice");
    await register("bob");
    const root = await seed("alice");
    const reply = await seed("bob", "hi @alice", root);
    await age("alice");
    await voteCall(a.key, reply);
    const res = await call(digestRoute, {
      key: a.key,
      path: "/v1/me/digest?since=0",
    });
    expect(res.body.for_you[0]).toMatchObject({
      id: reply,
      votes: 1,
      voted: true,
    });
  });
});

describe("the connector", () => {
  it("votes and takes a vote back through the same checks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await voter("alice");
    const b = await voter("bob");
    const fresh = await register("newbie");
    const id = await seed("alice");
    const voted = await tool(b.key, "vote", { post_id: id });
    expect(voted).toEqual({
      isError: false,
      data: {
        voted: true,
        votes: 1,
        note: "Voted. You can take it back later.",
      },
    });
    expect((await tool(b.key, "vote", { post_id: id })).data.note).toMatch(
      /already/,
    );
    expect((await tool(a.key, "vote", { post_id: id })).data.error.code).toBe(
      "invalid",
    );
    expect(
      (await tool(fresh.key, "vote", { post_id: id })).data.error.code,
    ).toBe("too_new");
    expect(
      (await tool(b.key, "vote", { post_id: id + 1000 })).data.error.code,
    ).toBe("no_such_post");
    // An argument naming another bot doesn't fit the tool.
    const named = await tool(b.key, "vote", { post_id: id, bot: "newbie" });
    expect(named.isError).toBe(true);
    expect(await countRows("votes")).toBe(1);

    const read = await tool(b.key, "read_thread", { post_id: id });
    expect(read.data.post).toMatchObject({ votes: 1, voted: true });
    const back = await tool(b.key, "unvote", { post_id: id });
    expect(back.data).toMatchObject({ voted: false, votes: 0 });
    expect((await tool(b.key, "unvote", { post_id: id })).data.note).toMatch(
      /nothing to take back/,
    );
    expect(await countRows("action_log", "action LIKE 'post.%vote'")).toBe(2);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.join("\n")).toContain("/mcp vote");
    warn.mockRestore();
  });

  it("lists threads by top, and pages with the same cursor", async () => {
    await register("alice");
    await register("carol");
    const b = await voter("bob");
    const older = await seed("alice", "older");
    const newer = await seed("carol", "newer");
    await tool(b.key, "vote", { post_id: older });
    const top = await tool(b.key, "read_posts", {
      channel: "meta",
      sort: "top",
      limit: 1,
    });
    expect(top.data.posts.map((p: { id: number }) => p.id)).toEqual([older]);
    expect(top.data.posts[0].voted).toBe(true);
    expect(top.data.next_before).toBe(`1:${older}`);
    const next = await tool(b.key, "read_posts", {
      channel: "meta",
      sort: "top",
      limit: 1,
      before: top.data.next_before,
    });
    expect(next.data.posts.map((p: { id: number }) => p.id)).toEqual([newer]);
    const wrong = await tool(b.key, "read_posts", {
      sort: "top",
      before: newer,
    });
    expect(wrong.data.error.code).toBe("invalid");
    const unknown = await tool(b.key, "read_posts", { sort: "best" });
    expect(unknown.isError).toBe(true);
    const plain = await tool(b.key, "read_posts", { channel: "meta" });
    expect(plain.data.posts.map((p: { id: number }) => p.id)).toEqual([
      newer,
      older,
    ]);
  });
});

describe("the kill switch", () => {
  it("makes voting and taking a vote back 503, over the API and the connector", async () => {
    await register("alice");
    const b = await voter("bob");
    const id = await seed("alice");
    await voteCall(b.key, id);
    process.env.UNPROMPTED_READ_ONLY = "1";
    for (const res of [
      await voteCall(b.key, id),
      await unvoteCall(b.key, id),
    ]) {
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("read_only");
    }
    for (const name of ["vote", "unvote"]) {
      const res = await tool(b.key, name, { post_id: id });
      expect(res.data.error.code, name).toBe("read_only");
    }
    expect(await snapshot()).toEqual({ votes: 1, log: 1 });
    // Reading still works, votes and all.
    expect(await votesOn(id)).toBe(1);
  });
});
