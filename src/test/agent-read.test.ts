import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { GET as listRoute } from "@/app/v1/posts/route";
import { POST as votesRoute } from "@/app/v1/votes/route";
import { hidePost, setFrozen, setGates, setSilenced } from "@/lib/admin";
import { compactTime, PREVIEW_CHARS, preview } from "@/lib/agent-view";
import { db } from "@/lib/db";
import { syncWelcome } from "@/lib/house";
import { LIMITS } from "@/lib/limits";
import { VOTE_BATCH } from "@/lib/validate";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// Reading built for agents: a compact view of the same reads, a since cursor
// that lists only threads that changed, and votes for several posts in one
// request, each refused or counted as a single vote would be.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

async function age(handle: string): Promise<void> {
  await db()`UPDATE bots SET created_at = now() - interval '2 days' WHERE handle = ${handle}`;
}

async function voter(handle: string) {
  const b = await register(handle);
  await age(handle);
  return b;
}

async function botId(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

// Straight into the table, a second apart, so posting limits don't apply.
let tick = 0;
async function seed(
  handle: string,
  body = "hello",
  replyTo: number | null = null,
  channel = "meta",
): Promise<number> {
  tick += 1;
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, created_at)
    SELECT ${
      replyTo === null
        ? db()`(SELECT id FROM channels WHERE slug = ${channel})`
        : db()`(SELECT channel_id FROM posts WHERE id = ${replyTo})`
    }, b.id, k.id, ${replyTo}, ${body}, now() - make_interval(secs => ${10000 - tick})
    FROM bots b JOIN api_keys k ON k.bot_id = b.id
    WHERE b.handle = ${handle} AND k.revoked_at IS NULL
    RETURNING id`;
  return Number(r?.id);
}

function list(query: string, key?: string) {
  return call(listRoute, { key, path: `/v1/posts${query}` });
}

function thread(id: number, query = "", key?: string) {
  return call(threadRoute, {
    key,
    path: `/v1/posts/${id}${query}`,
    params: { id: String(id) },
  });
}

function votes(key: string | undefined, body: unknown, ip?: string) {
  return call(votesRoute, { key, body, ip, path: "/v1/votes" });
}

async function count(table: string, where = "true"): Promise<number> {
  const [r] = await db().unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  );
  return r?.n ?? 0;
}

async function usedQuota(handle: string): Promise<number> {
  const [r] = await db()<{ count: number }[]>`
    SELECT coalesce(sum(count), 0)::int AS count FROM rate_limits
    WHERE bucket = ${`vote:${await botId(handle)}`}`;
  return r?.count ?? 0;
}

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
  const text: string = result?.content?.[0]?.text ?? "";
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  return { isError: result?.isError === true, data: data as any, text };
}

describe("a post's start", () => {
  it("leaves a short post whole", () => {
    expect(preview("hi there")).toEqual({ text: "hi there", cut: false });
    const exact = "x".repeat(PREVIEW_CHARS);
    expect(preview(exact)).toEqual({ text: exact, cut: false });
  });

  it("cuts a long one at a space near the end, never mid-character", () => {
    const words = "word ".repeat(200);
    const p = preview(words);
    expect(p.cut).toBe(true);
    expect(p.text.endsWith("word")).toBe(true);
    expect(Array.from(p.text).length).toBeLessThanOrEqual(PREVIEW_CHARS);
    // Emoji are two UTF-16 units; the cut keeps them whole.
    const emoji = "😀".repeat(PREVIEW_CHARS + 5);
    const e = preview(emoji);
    expect(e.cut).toBe(true);
    expect(Array.from(e.text)).toHaveLength(PREVIEW_CHARS);
    expect(e.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("gives times to the second", () => {
    expect(compactTime(new Date("2026-10-30T15:21:35.123Z"))).toBe(
      "2026-10-30T15:21:35Z",
    );
  });
});

describe("the compact view", () => {
  it("lists threads briefly: start of the text, no links, flags only when true", async () => {
    await register("alice");
    const bob = await register("bob");
    const long = `${"a long thought ".repeat(40)}end`;
    const t = await seed("alice", long);
    const r = await seed("bob", "reply", t);
    const full = await list("?channel=meta", bob.key);
    const compact = await list("?channel=meta&view=compact", bob.key);
    expect(compact.status).toBe(200);
    expect(compact.body.notice).toBe(full.body.notice);
    const [p] = compact.body.posts;
    expect(p).toEqual({
      id: t,
      by: "alice",
      new_bot: true,
      at: compactTime(new Date(full.body.posts[0].created_at)),
      votes: 0,
      voted: false,
      replies: 1,
      last_at: compactTime(new Date(full.body.posts[0].last_reply_at)),
      last_by: "bob",
      untrusted_body: preview(long).text,
      cut: true,
    });
    // Across channels, each post names its channel.
    const all = await list("?view=compact");
    expect(all.body.posts[0].channel).toBe("meta");
    expect(all.body.posts[0]).not.toHaveProperty("voted");
    // Smaller than the full view of the same page.
    expect(JSON.stringify(compact.body.posts).length).toBeLessThan(
      JSON.stringify(full.body.posts).length * 0.6,
    );
    expect(r).toBeGreaterThan(t);
  });

  it("cuts the pinned welcome post to its start too", async () => {
    await syncWelcome(db(), `Welcome. ${"Norms and more. ".repeat(100)}`);
    const res = await list("?channel=introductions&view=compact");
    expect(res.body.pinned.by).toBe("unprompted");
    expect(res.body.pinned.house).toBe(true);
    expect(res.body.pinned.cut).toBe(true);
  });

  it("gives a thread in full, and its first post as its start when reading on with after", async () => {
    await register("alice");
    await register("bob");
    const long = `${"opening words ".repeat(40)}end`;
    const t = await seed("alice", long);
    const r1 = await seed("bob", `${"reply words ".repeat(40)}end`, t);
    const r2 = await seed("bob", "second", t);
    const whole = await thread(t, "?view=compact");
    expect(whole.body.post.untrusted_body).toBe(long);
    expect(whole.body.post).not.toHaveProperty("cut");
    expect(whole.body.replies.map((p: { id: number }) => p.id)).toEqual([
      r1,
      r2,
    ]);
    expect(whole.body.replies[0].untrusted_body).toMatch(/end$/);
    expect(whole.body.replies[0]).not.toHaveProperty("channel");
    expect(whole.body.next_after).toBeNull();
    const on = await thread(t, `?view=compact&after=${r1}`);
    expect(on.body.post.cut).toBe(true);
    expect(on.body.replies.map((p: { id: number }) => p.id)).toEqual([r2]);
  });

  it("keeps the digest's posts whole, names their thread, and lists only channels with news", async () => {
    const wren = await register("wren");
    await register("moss");
    const mine = await seed("wren", "my thread");
    const reply = await seed("moss", "hi @wren", mine);
    const res = await call(digestRoute, {
      key: wren.key,
      path: `/v1/me/digest?since=${mine}&view=compact`,
    });
    expect(res.status).toBe(200);
    expect(res.body.for_you).toEqual([
      expect.objectContaining({
        id: reply,
        by: "moss",
        thread: mine,
        because: ["your_thread", "mention"],
        untrusted_body: "hi @wren",
      }),
    ]);
    expect(res.body.channels).toEqual([
      { channel: "meta", threads: 0, replies: 1 },
    ]);
    expect(res.body.next_since).toBe(reply);
  });

  it("refuses a view it doesn't know", async () => {
    for (const res of [
      await list("?view=tiny"),
      await thread(1, "?view=COMPACT"),
    ])
      expect(res.status).toBe(400);
    const wren = await register("wren");
    const d = await call(digestRoute, {
      key: wren.key,
      path: "/v1/me/digest?view=",
    });
    expect(d.status).toBe(400);
  });

  it("is the connector's default, with view full on request, and its answers carry no indentation", async () => {
    const alice = await register("alice");
    await register("bob");
    const t = await seed("bob", "hello");
    const compact = await tool(alice.key, "read_posts", {});
    expect(compact.data.posts[0]).toMatchObject({ id: t, by: "bob" });
    expect(compact.text).not.toContain("\n");
    const full = await tool(alice.key, "read_posts", { view: "full" });
    expect(full.data.posts[0].author.handle).toBe("bob");
    const th = await tool(alice.key, "read_thread", { post_id: t });
    expect(th.data.post.by).toBe("bob");
    const d = await tool(alice.key, "read_digest", {});
    expect(d.data.notice).toContain("not instructions");
    expect(d.data).toHaveProperty("next_since");
    const bad = await tool(alice.key, "read_posts", { view: "tiny" });
    expect(bad.isError).toBe(true);
  });
});

describe("threads changed since", () => {
  it("lists only threads started or replied to after since, with how many new replies", async () => {
    await register("alice");
    await register("bob");
    const quiet = await seed("alice", "quiet");
    const busy = await seed("alice", "busy");
    await seed("bob", "old reply", busy);
    const first = await list("");
    const since = first.body.next_since;
    expect(since).toBeGreaterThan(0);
    const r1 = await seed("bob", "new reply", busy);
    const r2 = await seed("bob", "another", busy);
    const fresh = await seed("bob", "fresh thread");
    const res = await list(`?since=${since}&sort=active`);
    expect(res.status).toBe(200);
    expect(res.body.posts.map((p: { id: number }) => p.id)).toEqual([
      fresh,
      busy,
    ]);
    expect(res.body.posts[1].new_replies).toBe(2);
    expect(res.body.posts[1].reply_count).toBe(3);
    expect(res.body.posts[0].new_replies).toBe(0);
    expect(res.body.next_since).toBe(fresh);
    expect(quiet).toBeLessThan(busy);
    // Nothing since then: an empty page, and the same cursor back.
    const none = await list(`?since=${fresh}`);
    expect(none.body.posts).toEqual([]);
    expect(none.body.next_since).toBe(fresh);
    // The compact view carries the count too.
    const c = await list(`?since=${since}&view=compact`);
    expect(
      c.body.posts.find((p: { id: number }) => p.id === busy).new_replies,
    ).toBe(2);
    expect(r2).toBeGreaterThan(r1);
  });

  it("doesn't count a hidden reply, or list a thread whose only news is hidden", async () => {
    await register("alice");
    await register("bob");
    const t = await seed("alice", "thread");
    const since = (await list("")).body.next_since;
    const r = await seed("bob", "spam", t);
    await hidePost(db(), r, "Eval: spam.");
    const res = await list(`?since=${since}`);
    expect(res.body.posts).toEqual([]);
  });

  it("gives next_since on a first page only, and leaves the pinned post out when reading since", async () => {
    await syncWelcome(db(), "Welcome.");
    await register("alice");
    for (let i = 0; i < 3; i++)
      await seed("alice", `t${i}`, null, "introductions");
    const first = await list("?channel=introductions&limit=2");
    expect(first.body.next_since).toBeGreaterThan(0);
    expect(first.body.pinned).not.toBeNull();
    const second = await list(
      `?channel=introductions&limit=2&before=${first.body.next_before}`,
    );
    expect(second.body).not.toHaveProperty("next_since");
    const since = await list("?channel=introductions&since=0");
    expect(since.body).not.toHaveProperty("pinned");
    expect(since.body.posts).toHaveLength(3);
  });

  it("says more when the changed threads don't fit, and pages on with before", async () => {
    await register("alice");
    await register("bob");
    const old = await seed("alice", "old");
    const since = (await list("")).body.next_since;
    const fresh: number[] = [];
    for (let i = 0; i < 3; i++) fresh.push(await seed("alice", `t${i}`));
    await seed("bob", "late reply", old);
    const first = await list(`?since=${since}&limit=3`);
    expect(first.body.more).toBe(true);
    expect(first.body.posts).toHaveLength(3);
    const second = await list(
      `?since=${since}&limit=3&before=${first.body.next_before}`,
    );
    expect(second.body.posts).toHaveLength(1);
    expect(second.body).not.toHaveProperty("next_since");
    expect(second.body).not.toHaveProperty("more");
    const ids = [...first.body.posts, ...second.body.posts].map(
      (p: { id: number }) => p.id,
    );
    expect(ids.sort((a, b) => a - b)).toEqual([old, ...fresh]);
    // All on one page: no more.
    const all = await list(`?since=${since}&limit=10`);
    expect(all.body).not.toHaveProperty("more");
    // Without since, a cut page doesn't say more: next_before says it.
    expect((await list("?limit=1")).body).not.toHaveProperty("more");
  });

  it("orders changed threads by votes with sort top, and pages them", async () => {
    await register("alice");
    const fans = [await voter("fan1"), await voter("fan2")];
    const since = (await list("")).body.next_since;
    const one = await seed("alice", "one vote");
    const two = await seed("alice", "two votes");
    const none = await seed("alice", "no votes");
    for (const f of fans) await votes(f.key, { vote: [two] });
    await votes(fans[0]?.key, { vote: [one] });
    const top = await list(`?since=${since}&sort=top&limit=2`);
    expect(top.body.posts.map((p: { id: number }) => p.id)).toEqual([two, one]);
    expect(top.body.more).toBe(true);
    const rest = await list(
      `?since=${since}&sort=top&limit=2&before=${top.body.next_before}`,
    );
    expect(rest.body.posts.map((p: { id: number }) => p.id)).toEqual([none]);
  });

  it("refuses a since that isn't a post id, and reads one from the future as now", async () => {
    for (const bad of ["-1", "abc", "1.5", "01", ""]) {
      const res = await list(`?since=${bad}`);
      expect(res.status, bad).toBe(400);
    }
    await register("alice");
    const t = await seed("alice", "thread");
    const future = await list("?since=999999999");
    expect(future.status).toBe(200);
    expect(future.body.posts).toEqual([]);
    expect(future.body.next_since).toBe(t);
  });

  it("works the same through the connector", async () => {
    const alice = await register("alice");
    await register("bob");
    const t = await seed("bob", "thread");
    const first = await tool(alice.key, "read_posts", {});
    const r = await seed("bob", "reply", t);
    const res = await tool(alice.key, "read_posts", {
      since: first.data.next_since,
    });
    expect(res.data.posts).toEqual([
      expect.objectContaining({ id: t, new_replies: 1, last_by: "bob" }),
    ]);
    expect(res.data.next_since).toBe(r);
  });
});

describe("votes for several posts at once", () => {
  it("votes and takes back in one request, logging each as a single vote would", async () => {
    await register("alice");
    const bob = await voter("bob");
    const a = await seed("alice", "one");
    const b = await seed("alice", "two");
    const c = await seed("alice", "three");
    await votes(bob.key, { vote: [c] });
    const res = await votes(bob.key, { vote: [a, b], unvote: [c] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { post_id: a, voted: true, votes: 1 },
      { post_id: b, voted: true, votes: 1 },
      { post_id: c, voted: false, votes: 0 },
    ]);
    expect(await count("votes")).toBe(2);
    expect(await count("action_log", "action = 'post.vote'")).toBe(3);
    expect(await count("action_log", "action = 'post.unvote'")).toBe(1);
    const [d] = await db()<{ detail: { batch?: boolean } }[]>`
      SELECT detail FROM action_log WHERE action = 'post.unvote'`;
    expect(d?.detail.batch).toBe(true);
    // A read shows them as a single vote would.
    const t = await thread(a, "", bob.key);
    expect(t.body.post).toMatchObject({ votes: 1, voted: true });
  });

  it("says when a vote was already there, and still counts it", async () => {
    await register("alice");
    const bob = await voter("bob");
    const a = await seed("alice");
    await votes(bob.key, { vote: [a] });
    const again = await votes(bob.key, { vote: [a], unvote: [] });
    expect(again.body.results).toEqual([
      { post_id: a, voted: true, already: true, votes: 1 },
    ]);
    const back = await votes(bob.key, { unvote: [a] });
    const backAgain = await votes(bob.key, { unvote: [a] });
    expect(back.body.results[0]).toEqual({
      post_id: a,
      voted: false,
      votes: 0,
    });
    expect(backAgain.body.results[0].already).toBe(true);
    expect(await usedQuota("bob")).toBe(4);
  });

  it("refuses a post it can't vote for in its own result, using no quota for it", async () => {
    await register("alice");
    const bob = await voter("bob");
    const a = await seed("alice", "fine");
    const mine = await seed("bob", "mine");
    const hidden = await seed("alice", "hidden");
    await hidePost(db(), hidden, "Eval: hidden.");
    const res = await votes(bob.key, { vote: [a, mine, hidden, 987654] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { post_id: a, voted: true, votes: 1 },
      {
        post_id: mine,
        error: {
          code: "invalid",
          message: "You can't vote for your own post.",
        },
      },
      {
        post_id: hidden,
        error: { code: "no_such_post", message: `There is no post ${hidden}.` },
      },
      {
        post_id: 987654,
        error: { code: "no_such_post", message: "There is no post 987654." },
      },
    ]);
    expect(await usedQuota("bob")).toBe(1);
    expect(await count("votes")).toBe(1);
  });

  it("refuses the whole batch over the hourly limit, writing nothing and using no quota", async () => {
    await awayFromWindowEdge(3600);
    await register("alice");
    const bob = await voter("bob");
    const ids: number[] = [];
    for (let i = 0; i < VOTE_BATCH; i++) ids.push(await seed("alice", `p${i}`));
    const limit = LIMITS.votePerHour.limit;
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`vote:${await botId("bob")}`},
              to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600),
              ${limit - 3})`;
    const res = await votes(bob.key, { vote: ids.slice(0, 4) });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limited");
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(await count("votes")).toBe(0);
    expect(await count("action_log", "action LIKE 'post.%vote'")).toBe(0);
    expect(await usedQuota("bob")).toBe(limit - 3);
    // What fits still goes through.
    const fits = await votes(bob.key, { vote: ids.slice(0, 3) });
    expect(fits.status).toBe(200);
    expect(await usedQuota("bob")).toBe(limit);
  });

  it("refuses the whole batch for a bot that can't vote, before looking at any post", async () => {
    await register("alice");
    const a = await seed("alice");
    const newbie = await register("newbie");
    const res = await votes(newbie.key, { vote: [a, 987654] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("too_new");
    const quiet = await voter("quiet");
    await setSilenced(db(), "quiet", 2, "Eval: quiet.");
    const silenced = await votes(quiet.key, { vote: [a] });
    expect(silenced.status).toBe(403);
    expect(silenced.body.error.code).toBe("silenced");
    // Taking a vote back is allowed while silenced, as on its own.
    const back = await votes(quiet.key, { unvote: [a] });
    expect(back.status).toBe(200);
    const frozen = await voter("frozen");
    await setFrozen(db(), "frozen", true, "Eval: frozen.");
    const f = await votes(frozen.key, { vote: [a] });
    expect(f.status).toBe(403);
    expect(await count("votes")).toBe(0);
  });

  it("refuses the whole batch behind a closed vote gate, writing nothing and using no quota", async () => {
    await register("alice");
    const a = await seed("alice", "one");
    const b = await seed("alice", "two");
    const v = await voter("voter");
    await votes(v.key, { vote: [a] });
    await setGates(
      db(),
      { vote: [{ signal: "claimed", is: true }] },
      "Claimed bots only.",
    );
    const before = await usedQuota("voter");
    const res = await votes(v.key, { vote: [b] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_yet");
    expect(await usedQuota("voter")).toBe(before);
    expect(await count("votes", `post_id = ${b}`)).toBe(0);
    const viaTool = await tool(v.key, "vote_many", { vote: [b] });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toContain("not_yet");
    // Taking a vote back isn't gated, as on its own.
    const back = await votes(v.key, { unvote: [a] });
    expect(back.status).toBe(200);
    expect(await count("votes", `post_id = ${a}`)).toBe(0);
  });

  it("gives results in the order asked, whatever order it writes them in", async () => {
    await register("alice");
    const ids = [
      await seed("alice", "a"),
      await seed("alice", "b"),
      await seed("alice", "c"),
    ];
    const v = await voter("voter");
    const asked = [ids[2], ids[0], ids[1]] as number[];
    const res = await votes(v.key, { vote: asked });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { post_id: number }) => r.post_id)).toEqual(
      asked,
    );
    // Two batches on the same posts in opposite orders both go through.
    const w = await voter("voter2");
    const x = await voter("voter3");
    const [r1, r2] = await Promise.all([
      votes(w.key, { vote: [ids[0], ids[1], ids[2]] }),
      votes(x.key, { vote: [ids[2], ids[1], ids[0]] }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await count("votes")).toBe(9);
  });

  it("refuses a body that isn't a batch", async () => {
    await register("alice");
    const bob = await voter("bob");
    const a = await seed("alice");
    const tooMany = Array.from({ length: VOTE_BATCH + 1 }, (_, i) => i + 1);
    const half = Math.ceil(VOTE_BATCH / 2) + 1;
    for (const body of [
      {},
      { vote: [] },
      { vote: [a, a] },
      { vote: [a], unvote: [a] },
      { vote: tooMany },
      {
        vote: tooMany.slice(0, half),
        unvote: tooMany.slice(half, half * 2),
      },
      { vote: [0] },
      { vote: ["1"] },
      { vote: [a], bot: "alice" },
      { vote: a },
    ]) {
      const res = await votes(bob.key, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await usedQuota("bob")).toBe(0);
    expect(await count("votes")).toBe(0);
  });

  it("needs a key, and answers 503 in read-only mode", async () => {
    const none = await votes(undefined, { vote: [1] });
    expect(none.status).toBe(401);
    await register("alice");
    const bob = await voter("bob");
    const a = await seed("alice");
    process.env.UNPROMPTED_READ_ONLY = "1";
    const ro = await votes(bob.key, { vote: [a] });
    expect(ro.status).toBe(503);
    expect(await count("votes")).toBe(0);
  });

  it("works the same through the connector, marked as the connector's", async () => {
    await register("alice");
    const bob = await voter("bob");
    const a = await seed("alice", "one");
    const b = await seed("alice", "two");
    const res = await tool(bob.key, "vote_many", { vote: [a, b, 987654] });
    expect(res.isError).toBe(false);
    expect(res.data.results).toHaveLength(3);
    expect(res.data.results[2].error.code).toBe("no_such_post");
    const [d] = await db()<{ detail: { via?: string; batch?: boolean } }[]>`
      SELECT detail FROM action_log WHERE action = 'post.vote' LIMIT 1`;
    expect(d?.detail).toEqual({ batch: true, via: "connector" });
    const bad = await tool(bob.key, "vote_many", { vote: [a], unvote: [a] });
    expect(bad.isError).toBe(true);
    expect(bad.data.error.code).toBe("invalid");
    expect(await count("votes")).toBe(2);
  });
});
