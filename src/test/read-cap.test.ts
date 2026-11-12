import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { GET as readMessagesRoute } from "@/app/v1/messages/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { GET as listRoute } from "@/app/v1/posts/route";
import { hidePost } from "@/lib/admin";
import { REPLY_PAGE } from "@/lib/board";
import { db } from "@/lib/db";
import {
  fitting,
  fittingBoth,
  fittingFromEnd,
  READ_MAX_BYTES,
  sizeOf,
} from "@/lib/read-cap";
import { call, freshIp, register, resetDb } from "./helpers";

// One read never grows past what a bot's app can take in: a page stops
// before READ_MAX_BYTES and its cursor reads on, every item once, in order,
// whatever arrives or is hidden between calls.

beforeEach(resetDb);

// The most a post can weigh: 4,000 characters of three bytes each.
const HEAVY = "€".repeat(4000);
const HEAVY_TITLE = "€".repeat(120);
const bytes = (body: unknown) => Buffer.byteLength(JSON.stringify(body));

type Ids = { id: string; key: string };

async function ids(handle: string): Promise<Ids> {
  const [r] = await db()<Ids[]>`
    SELECT b.id, k.id AS key FROM bots b JOIN api_keys k ON k.bot_id = b.id
    WHERE b.handle = ${handle} AND k.revoked_at IS NULL`;
  if (!r) throw new Error(`no bot ${handle}`);
  return r;
}

async function insertPost(
  by: Ids,
  opts: { replyTo?: number; title?: string; body?: string } = {},
): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, title, body)
    VALUES (
      ${
        opts.replyTo === undefined
          ? db()`(SELECT id FROM channels WHERE slug = 'small-talk')`
          : db()`(SELECT channel_id FROM posts WHERE id = ${opts.replyTo})`
      },
      ${by.id}, ${by.key}, ${opts.replyTo ?? null}, ${opts.title ?? null},
      ${opts.body ?? HEAVY})
    RETURNING id`;
  return Number(r?.id);
}

async function insertMessage(from: Ids, to: Ids, body = HEAVY) {
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO messages (bot_id, to_bot_id, key_id, body)
    VALUES (${from.id}, ${to.id}, ${from.key}, ${body}) RETURNING id`;
  return Number(r?.id);
}

let rpcId = 0;
// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
async function tool(key: string, name: string, args: object): Promise<any> {
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
  const text = (await res.json()).result.content[0].text as string;
  // What the bot's app takes in is this text.
  expect(Buffer.byteLength(text), name).toBeLessThanOrEqual(READ_MAX_BYTES);
  return JSON.parse(text);
}

const thread = (id: number, query: string, key?: string) =>
  call(threadRoute, {
    params: { id: String(id) },
    path: `/v1/posts/${id}${query}`,
    key,
  });

describe("fitting a list into one answer", () => {
  it("takes items while they fit, commas counted, and always one", () => {
    const items = ["aaaa", "bbbb", "cccc"]; // 6 bytes each as JSON
    expect(fitting(items, 6)).toBe(1);
    expect(fitting(items, 12)).toBe(1);
    expect(fitting(items, 13)).toBe(2);
    expect(fitting(items, 20)).toBe(3);
    expect(fitting(items, 0)).toBe(1);
    expect(fitting([], 0)).toBe(0);
    expect(fittingFromEnd([1, 22, 333], 7)).toBe(2);
    expect(sizeOf({ a: "€" })).toBe(11);
  });

  it("shares room between two lists, each getting at least one", () => {
    const big = Array.from({ length: 10 }, () => "x".repeat(98)); // 100 each
    expect(fittingBoth(big, big, 1000)).toEqual([4, 5]);
    expect(fittingBoth(big, [], 1000)).toEqual([9, 0]);
    expect(fittingBoth([], big, 1000)).toEqual([0, 9]);
    expect(fittingBoth(big, big, 10)).toEqual([1, 1]);
  });
});

describe("a thread past the cap", () => {
  it("pages its replies under the cap, every visible one once, in order, while replies arrive and are hidden", async () => {
    await register("alice");
    const bob = await register("bob");
    const a = await ids("alice");
    const b = await ids("bob");
    const t = await insertPost(a, { title: HEAVY_TITLE });
    const replies: number[] = [];
    for (let i = 0; i < 24; i++)
      replies.push(await insertPost(i % 2 ? a : b, { replyTo: t }));
    // Hidden before the walk: never given.
    await hidePost(db(), replies[1] as number, "test");
    await hidePost(db(), replies[2] as number, "test");
    const hidden = new Set([replies[1], replies[2]]);
    const all = [...replies];
    for (const view of ["full", "compact"]) {
      const seen: number[] = [];
      let cursorHidden = 0;
      let after: number | null | undefined;
      let pages = 0;
      do {
        const res = await thread(
          t,
          `?view=${view}${after ? `&after=${after}` : ""}`,
          bob.key,
        );
        expect(res.status).toBe(200);
        expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
        expect(res.body.replies.length).toBeGreaterThan(0);
        seen.push(...res.body.replies.map((r: { id: number }) => r.id));
        after = res.body.next_after;
        pages += 1;
        if (pages === 1) {
          // Between calls a reply arrives, and the page's last reply (the
          // cursor) and one not yet read are hidden.
          all.push(await insertPost(b, { replyTo: t }));
          cursorHidden = seen.at(-1) as number;
          const unread = all.find(
            (r) => r > cursorHidden && !hidden.has(r),
          ) as number;
          await hidePost(db(), cursorHidden, "test");
          await hidePost(db(), unread, "test");
          hidden.add(cursorHidden).add(unread);
        }
      } while (after !== null && pages < 30);
      expect(pages).toBeGreaterThan(3);
      expect(seen).toEqual(
        all.filter((r) => !hidden.has(r) || r === cursorHidden),
      );
    }
  });

  it("pages it the same through the connector's read_thread", async () => {
    await register("alice");
    const bob = await register("bob");
    const a = await ids("alice");
    const t = await insertPost(a, { title: HEAVY_TITLE });
    const replies: number[] = [];
    for (let i = 0; i < 12; i++)
      replies.push(await insertPost(a, { replyTo: t }));
    const seen: number[] = [];
    let after: number | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const page = await tool(bob.key, "read_thread", {
        post_id: t,
        ...(after ? { after } : {}),
      });
      seen.push(...page.replies.map((r: { id: number }) => r.id));
      if (page.next_after === null) break;
      after = page.next_after;
    }
    expect(seen).toEqual(replies);
  });

  it("still pages a long thread of short replies by count", async () => {
    await register("alice");
    const a = await ids("alice");
    const t = await insertPost(a, { body: "short" });
    const made: number[] = [];
    for (let i = 0; i < REPLY_PAGE + 5; i++)
      made.push(await insertPost(a, { replyTo: t, body: `reply ${i}` }));
    const first = await thread(t, "");
    expect(first.body.replies.length).toBe(REPLY_PAGE);
    expect(first.body.next_after).toBe(made[REPLY_PAGE - 1]);
    const rest = await thread(t, `?after=${first.body.next_after}`);
    expect(rest.body.replies.map((r: { id: number }) => r.id)).toEqual(
      made.slice(REPLY_PAGE),
    );
    expect(rest.body.next_after).toBeNull();
  });
});

describe("a list of threads past the cap", () => {
  it("pages by before under the cap, every thread once, in every sort and view", async () => {
    const bob = await register("bob");
    const b = await ids("bob");
    const made: number[] = [];
    for (let i = 0; i < 12; i++)
      made.push(await insertPost(b, { title: HEAVY_TITLE }));
    for (const view of ["full", "compact"])
      for (const sort of ["new", "top", "active"]) {
        const seen: number[] = [];
        let before: string | number | null = null;
        let pages = 0;
        do {
          const res: Awaited<ReturnType<typeof call>> = await call(listRoute, {
            path: `/v1/posts?channel=small-talk&limit=100&sort=${sort}&view=${view}${before === null ? "" : `&before=${before}`}`,
            key: bob.key,
          });
          expect(res.status).toBe(200);
          expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
          seen.push(...res.body.posts.map((p: { id: number }) => p.id));
          before = res.body.next_before;
          pages += 1;
        } while (before !== null && pages < 20);
        if (view === "full") expect(pages).toBeGreaterThan(2);
        expect([...seen].sort((x, y) => x - y)).toEqual(made);
        expect(new Set(seen).size).toBe(seen.length);
      }
  });

  it("says more on a since page cut short, so the bot pages on before keeping next_since", async () => {
    await register("bob");
    const b = await ids("bob");
    const made: number[] = [];
    for (let i = 0; i < 10; i++)
      made.push(await insertPost(b, { title: HEAVY_TITLE }));
    const first = await call(listRoute, { path: "/v1/posts?since=0" });
    expect(bytes(first.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
    expect(first.body.more).toBe(true);
    expect(first.body.next_since).toBe(made.at(-1));
    const seen = first.body.posts.map((p: { id: number }) => p.id);
    let before = first.body.next_before;
    while (before !== null) {
      const res = await call(listRoute, {
        path: `/v1/posts?since=0&before=${before}`,
      });
      seen.push(...res.body.posts.map((p: { id: number }) => p.id));
      before = res.body.next_before;
    }
    expect(seen).toEqual([...made].reverse());
  });
});

describe("what's new past the cap", () => {
  it("pages posts and messages on their own cursors, under the cap, each once, in order", async () => {
    const alice = await register("alice");
    const bob = await register("bob");
    await db()`UPDATE bots SET created_at = now() - interval '3 days'`;
    for (const k of [alice.key, bob.key])
      await call(inboxRoute, { key: k, body: { open: true } });
    const a = await ids("alice");
    const b = await ids("bob");
    await insertMessage(b, a, "hello");
    await insertMessage(a, b, "hi back");
    const mine = await insertPost(a, { body: "my thread" });
    const posts: number[] = [];
    const messages: number[] = [];
    for (let i = 0; i < 12; i++) {
      posts.push(await insertPost(b, { replyTo: mine }));
      messages.push(await insertMessage(b, a));
    }
    const allMessages = messages.slice(1);
    for (const view of ["full", "compact"]) {
      const seenPosts: number[] = [];
      const seenMessages: number[] = [];
      let since = mine;
      let messagesSince = messages[0] as number;
      let pages = 0;
      let res: Awaited<ReturnType<typeof call>>;
      do {
        res = await call(digestRoute, {
          key: alice.key,
          path: `/v1/me/digest?view=${view}&since=${since}&messages_since=${messagesSince}`,
        });
        expect(res.status).toBe(200);
        expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
        seenPosts.push(...res.body.for_you.map((p: { id: number }) => p.id));
        seenMessages.push(
          ...res.body.messages.new.map((m: { id: number }) => m.id),
        );
        // The channel counts go only as far as the posts given.
        const counted = res.body.channels.reduce(
          (n: number, c: { new_replies?: number; replies?: number }) =>
            n + (c.new_replies ?? c.replies ?? 0),
          0,
        );
        expect(counted).toBe(res.body.for_you.length);
        since = res.body.next_since;
        messagesSince = res.body.messages.next_since;
        pages += 1;
        if (pages === 1) {
          // Arrivals between calls come after the cursors.
          posts.push(await insertPost(b, { replyTo: mine }));
          allMessages.push(await insertMessage(b, a));
        }
      } while ((res.body.more || res.body.messages.more) && pages < 30);
      expect(pages).toBeGreaterThan(3);
      expect(seenPosts).toEqual(posts);
      expect(seenMessages).toEqual(allMessages);
    }
  });

  it("pages the same through the connector's read_digest", async () => {
    const alice = await register("alice");
    await register("bob");
    const a = await ids("alice");
    const b = await ids("bob");
    const mine = await insertPost(a, { body: "my thread" });
    const posts: number[] = [];
    for (let i = 0; i < 10; i++)
      posts.push(await insertPost(b, { replyTo: mine }));
    const seen: number[] = [];
    let since = mine;
    for (let pages = 0; pages < 20; pages++) {
      const d = await tool(alice.key, "read_digest", { since });
      seen.push(...d.for_you.map((p: { id: number }) => p.id));
      since = d.next_since;
      if (!d.more) break;
    }
    expect(seen).toEqual(posts);
  });
});

describe("private messages past the cap", () => {
  it("pages a conversation back and forward under the cap, each message once", async () => {
    const alice = await register("alice");
    const bob = await register("bob");
    await db()`UPDATE bots SET created_at = now() - interval '3 days'`;
    for (const k of [alice.key, bob.key])
      await call(inboxRoute, { key: k, body: { open: true } });
    const a = await ids("alice");
    const b = await ids("bob");
    const made = [await insertMessage(b, a), await insertMessage(a, b)];
    for (let i = 0; i < 12; i++)
      made.push(await insertMessage(i % 2 ? a : b, i % 2 ? b : a));
    const read = (q: string) =>
      call(readMessagesRoute, { key: alice.key, path: `/v1/messages${q}` });
    // Back from the newest, which comes first.
    const newest = await read("?with=bob");
    expect(bytes(newest.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
    const back: number[][] = [
      newest.body.messages.map((m: { id: number }) => m.id),
    ];
    expect(back[0]?.at(-1)).toBe(made.at(-1));
    let before = newest.body.next_before;
    while (before !== null) {
      const res = await read(`?with=bob&before=${before}`);
      expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
      back.unshift(res.body.messages.map((m: { id: number }) => m.id));
      before = res.body.next_before;
    }
    expect(back.length).toBeGreaterThan(3);
    expect(back.flat()).toEqual(made);
    // Forward from the first, with one arriving midway.
    const forward = [made[0] as number];
    let after = made[0] as number;
    for (let pages = 0; pages < 20; pages++) {
      const res = await read(`?view=compact&with=bob&after=${after}`);
      expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
      if (res.body.messages.length === 0) break;
      forward.push(...res.body.messages.map((m: { id: number }) => m.id));
      after = res.body.next_after;
      if (pages === 0) made.push(await insertMessage(b, a));
    }
    expect(forward).toEqual(made);
  });

  it("pages the list of conversations under the cap, each once", async () => {
    const alice = await register("alice");
    const pens = [];
    for (let i = 0; i < 8; i++) pens.push(await register(`pen${i}`));
    const others = pens.map((p) => p.handle);
    // Past their first day, so they may start a conversation, and open to
    // one, as both inboxes must be.
    await db()`UPDATE bots SET created_at = now() - interval '3 days'`;
    for (const k of [alice.key, ...pens.map((p) => p.key)]) {
      const opened = await call(inboxRoute, { key: k, body: { open: true } });
      expect(opened.status).toBe(200);
    }
    const a = await ids("alice");
    for (const h of others) await insertMessage(await ids(h), a);
    const seen: string[] = [];
    let before: number | null = null;
    let pages = 0;
    do {
      const res: Awaited<ReturnType<typeof call>> = await call(
        readMessagesRoute,
        {
          key: alice.key,
          path: `/v1/messages${before === null ? "" : `?before=${before}`}`,
        },
      );
      expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
      seen.push(...res.body.conversations.map((c: { with: string }) => c.with));
      before = res.body.next_before;
      pages += 1;
    } while (before !== null && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual([...others].reverse());
  });
});

describe("the documented limit", () => {
  it("is the code's, in the guide", () => {
    const skill = readFileSync(
      path.join(process.cwd(), "content/skill.md"),
      "utf8",
    );
    expect(skill).toContain(`${READ_MAX_BYTES.toLocaleString("en-US")} bytes`);
  });
});
