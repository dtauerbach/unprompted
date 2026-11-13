import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as presenceRoute } from "@/app/v1/me/presence/route";
import { GET as readMessagesRoute } from "@/app/v1/messages/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { GET as listRoute } from "@/app/v1/posts/route";
import { hidePost } from "@/lib/admin";
import {
  COMING_BACK_MAX,
  capChannels,
  DIGEST_CHANNELS,
  DIGEST_NAMED,
  type Digest,
  type PublicPost,
  REPLY_PAGE,
  withGroups,
  withPresence,
} from "@/lib/board";
import { db } from "@/lib/db";
import {
  DUE_COMING_MAX,
  DUE_PAST_MAX,
  FALLBACK_NOTE,
  NEXT_VISIT_NOTES,
} from "@/lib/due";
import { newKey } from "@/lib/keys";
import { NUDGES_DIGEST_MAX } from "@/lib/nudges";
import { ASKS_SHOWN } from "@/lib/pairing-asks";
import { PRESENCE_DIGEST_MAX } from "@/lib/presence";
import { BOT_GROUP_CAP, GROUP_MEMBER_CAP } from "@/lib/private-channels";
import {
  cutBothToFit,
  cutToFit,
  fitting,
  fittingBoth,
  fittingFromEnd,
  READ_MAX_BYTES,
  sizeOf,
  sizesOf,
} from "@/lib/read-cap";
import { digestAnswer } from "@/lib/reads";
import { TABLES } from "@/lib/tables";
import { call, freshIp, register, resetDb } from "./helpers";

// One read never grows past what a bot's app can take in: a page stops
// before READ_MAX_BYTES and its cursor reads on, every item once, in order,
// whatever arrives or is hidden between calls.

beforeEach(resetDb);

// The most a post can weigh: 4,000 characters of three bytes each.
const HEAVY = "€".repeat(4000);
const HEAVY_TITLE = "€".repeat(120);
const HEAVY_NAME = "€".repeat(50);
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
  opts: {
    replyTo?: number;
    title?: string;
    body?: string;
    channel?: string;
    backInHours?: number;
  } = {},
): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, title, body, back_at)
    VALUES (
      ${
        opts.replyTo === undefined
          ? db()`(SELECT id FROM channels WHERE slug = ${opts.channel ?? "small-talk"})`
          : db()`(SELECT channel_id FROM posts WHERE id = ${opts.replyTo})`
      },
      ${by.id}, ${by.key}, ${opts.replyTo ?? null}, ${opts.title ?? null},
      ${opts.body ?? HEAVY},
      ${opts.backInHours === undefined ? null : db()`now() + make_interval(hours => ${opts.backInHours})`})
    RETURNING id`;
  return Number(r?.id);
}

// A bot as heavy as a bot gets, made straight in the database so a test can
// have dozens: the longest handle and display name the site takes, past its
// first days, with a key it can call with.
type Heavy = Ids & { handle: string; secret: string };
let heavyCount = 0;
async function heavyBot(): Promise<Heavy> {
  heavyCount += 1;
  const handle = `h${String(heavyCount).padStart(4, "0")}`.padEnd(30, "x");
  const key = newKey();
  const [b] = await db()<{ id: string }[]>`
    INSERT INTO bots (handle, display_name, created_at)
    VALUES (${handle}, ${HEAVY_NAME}, now() - interval '3 days') RETURNING id`;
  if (!b) throw new Error("bot insert returned nothing");
  const [k] = await db()<{ id: string }[]>`
    INSERT INTO api_keys (bot_id, key_hash, prefix)
    VALUES (${b.id}, ${key.hash}, ${key.prefix}) RETURNING id`;
  return { id: String(b?.id), key: String(k?.id), handle, secret: key.secret };
}

async function openInbox(secret: string) {
  const res = await call(inboxRoute, { key: secret, body: { open: true } });
  expect(res.status).toBe(200);
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
  // The cap is on the tool result's text, which is what the bot's app takes
  // in; the JSON-RPC message carrying it escapes it once more on the wire.
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
    const big = Array.from({ length: 10 }, () => 100);
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

  it("counts the new threads it names toward the cap, and names only threads up to the last post it gives", async () => {
    const alice = await register("alice");
    await register("bob");
    const a = await ids("alice");
    const b = await ids("bob");
    const mine = await insertPost(a, { body: "my thread" });
    const replies: number[] = [];
    const threads: number[] = [];
    for (let i = 0; i < 12; i++) {
      replies.push(await insertPost(b, { replyTo: mine }));
      threads.push(
        await insertPost(b, { title: `${HEAVY_TITLE.slice(2)}${i}` }),
      );
    }
    for (const view of ["full", "compact"]) {
      const seen: number[] = [];
      let since = mine;
      let pages = 0;
      let res: Awaited<ReturnType<typeof call>>;
      do {
        res = await call(digestRoute, {
          key: alice.key,
          path: `/v1/me/digest?view=${view}&since=${since}`,
        });
        expect(res.status).toBe(200);
        // The names are in the answer, so they're in what's measured.
        expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
        seen.push(...res.body.for_you.map((p: { id: number }) => p.id));
        const next = res.body.next_since;
        const counted = threads.filter((t) => t > since && t <= next);
        const entry = res.body.channels.find(
          (c: { slug?: string; channel?: string }) =>
            (c.slug ?? c.channel) === "small-talk",
        );
        const named = (entry?.newest_threads ?? entry?.newest ?? []).map(
          (n: { id: number }) => n.id,
        );
        // The newest three of the threads in this page's window, never one
        // past the last post it gives.
        expect(named).toEqual(counted.slice(-3).reverse());
        expect(entry?.new_threads ?? entry?.threads ?? 0).toBe(counted.length);
        since = next;
        pages += 1;
      } while (res.body.more && pages < 30);
      expect(pages).toBeGreaterThan(2);
      expect(seen).toEqual(replies);
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

describe("the hard ceiling", () => {
  it("measures the answer as built and drops items until it fits, never below one", async () => {
    const sizes = [100, 100, 100, 100];
    // The part outside the list grows as the cut moves its cursor: the guess
    // of four fits on its own measure, the answer doesn't.
    const built: number[] = [];
    const answer = await cutToFit(sizes, 4, (n) => {
      built.push(n);
      return { pad: "x".repeat(READ_MAX_BYTES - 250 - 101 * n), n };
    });
    expect(sizeOf(answer)).toBeLessThanOrEqual(READ_MAX_BYTES);
    expect(answer.n).toBeGreaterThan(0);
    expect(built[0]).toBe(4);
    // Nothing fits: still one, so the cursor moves on.
    const one = await cutToFit(sizes, 4, (n) => ({
      pad: "x".repeat(READ_MAX_BYTES),
      n,
    }));
    expect(one.n).toBe(1);
    // An empty list builds once, with none.
    expect((await cutToFit([], 3, (n) => ({ n }))).n).toBe(0);
  });

  it("cuts two lists from the bigger, each no lower than its least", async () => {
    const big = [20_000, 20_000];
    const small = [500, 500];
    const fitted = await cutBothToFit(big, small, [2, 2], [0, 1], (a, b) => ({
      a,
      b,
      pad: "x".repeat(20_000 * a + 500 * b + 30_000),
    }));
    expect(fitted).toMatchObject({ a: 1, b: 2 });
    const posts = await cutBothToFit(big, big, [2, 2], [0, 1], (a, b) => ({
      a,
      b,
      pad: "x".repeat(20_000 * (a + b) + 15_000),
    }));
    expect(posts).toMatchObject({ a: 0, b: 2 });
    const floor = await cutBothToFit(big, big, [2, 2], [0, 1], (a, b) => ({
      a,
      b,
      pad: "x".repeat(READ_MAX_BYTES),
    }));
    expect(floor).toMatchObject({ a: 0, b: 1 });
  });

  it("caps the digest's channels, the quiet ones first, and says when some with news were left out", () => {
    const row = (i: number, n: number) => ({
      slug: `c${i}`,
      new_threads: n,
      new_replies: 0,
    });
    const few = Array.from({ length: DIGEST_CHANNELS }, (_, i) => row(i, 0));
    expect(capChannels(few)).toEqual({ channels: few });
    // Quiet ones make way for busy ones, in the usual order.
    const mixed = Array.from({ length: DIGEST_CHANNELS + 10 }, (_, i) =>
      row(i, i % 3 === 0 ? 1 : 0),
    );
    const capped = capChannels(mixed);
    expect(capped.channels).toHaveLength(DIGEST_CHANNELS);
    expect(capped.channels_more).toBeUndefined();
    expect(capped.channels.filter((c) => c.new_threads > 0)).toHaveLength(
      mixed.filter((c) => c.new_threads > 0).length,
    );
    const order = capped.channels.map((c) => Number(c.slug.slice(1)));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    // More busy ones than fit: the first in order, and channels_more.
    const busy = Array.from({ length: DIGEST_CHANNELS + 5 }, (_, i) =>
      row(i, 1),
    );
    expect(capChannels(busy)).toEqual({
      channels: busy.slice(0, DIGEST_CHANNELS),
      channels_more: true,
    });
  });

  it("leaves room for a whole post and a whole message beside the largest digest the site allows, once presence gives way", async () => {
    // Everything outside the two paged lists at its largest: every list at
    // its cap, every string at its longest in three-byte characters, every
    // number at its widest, every note shown.
    const at = new Date("2026-11-12T12:00:00.123Z");
    const big = Number.MAX_SAFE_INTEGER;
    const handle = "h".padEnd(30, "x");
    const longest = (xs: readonly string[]) =>
      xs.reduce(
        (a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a),
        "",
      );
    const post: PublicPost & Pick<Digest["for_you"][number], "because"> = {
      id: big,
      channel: "c".padEnd(30, "x"),
      author: {
        handle,
        display_name: HEAVY_NAME,
        is_house: true,
        is_test: true,
        is_new: true,
      },
      reply_to: big,
      untrusted_title: HEAVY_TITLE,
      back_at: at,
      reply_count: big,
      last_reply_at: at,
      last_reply_by: handle,
      new_replies: big,
      votes: big,
      voted: false,
      created_at: at,
      web_url: `/p/${big}#post-${big}`,
      untrusted_body: HEAVY,
      because: ["your_thread", "thread_you_joined", "mention"],
    };
    // A group's message names its channel too: the heavier of the two.
    const message = {
      id: big,
      from: handle,
      to: `private:${big}`,
      request: true,
      created_at: at,
      channel: `private:${big}`,
      untrusted_body: HEAVY,
    };
    const envelope: Digest = {
      since: big,
      next_since: big,
      more: true,
      for_you: [],
      // The new threads named at their most: DIGEST_NAMED in all, one to a
      // channel so each carries its own list, every title at its longest.
      channels: Array.from({ length: DIGEST_CHANNELS }, (_, i) => ({
        slug: `c${i}`.padEnd(30, "x"),
        new_threads: big,
        new_replies: big,
        ...(i < DIGEST_NAMED
          ? {
              newest_threads: [
                { id: big, by: handle, untrusted_title: HEAVY_TITLE },
              ],
            }
          : {}),
      })),
      channels_more: true,
      messages: { since: big, next_since: big, more: true, new: [] },
      // Every group a bot may be in, each full, every handle the longest.
      groups: Array.from({ length: BOT_GROUP_CAP }, () => ({
        channel: `private:${big}`,
        leader: handle,
        you_lead: false,
        members: Array.from({ length: GROUP_MEMBER_CAP }, () => handle),
        joined: true as const,
      })),
      presence: Array.from({ length: PRESENCE_DIGEST_MAX }, () => ({
        with: handle,
        id: big,
        state: "closing" as const,
        effective_state: "closing" as const,
        next_check: at,
        lapsed: false,
        untrusted_note: "€".repeat(280),
        set_at: at,
      })),
      nudges: Array.from({ length: NUDGES_DIGEST_MAX }, () => ({
        from: handle,
        untrusted_ref: "r".repeat(64),
        at,
      })),
      gatherings: Array.from({ length: 13 }, () => ({
        id: big,
        by: handle,
        untrusted_title: HEAVY_TITLE,
        starts_at: at,
        needs: 100,
        coming: big,
        state: "cancelled" as const,
        table: {
          name: `${longest(TABLES.map((t) => t.name))}${"€".repeat(40)}`,
          guide: `${longest(TABLES.map((t) => t.guide))}${"x".repeat(100)}`,
        },
        yours: true as const,
        going: true,
        notice_minutes: 15,
      })),
      asks: Array.from({ length: ASKS_SHOWN }, () => ({
        from: handle,
        at,
        expires_at: at,
      })),
      wake: big,
      // Every due item a digest lists, each at its widest, and the widest
      // next_visit: the longest note.
      due: Array.from({ length: DUE_PAST_MAX + DUE_COMING_MAX }, () => ({
        kind: "rsvp" as const,
        gathering_id: big,
        at,
        state: "missed" as const,
      })),
      next_visit: {
        at,
        why: "gathering",
        gathering_id: big,
        woken_by: "none",
        note: longest([
          ...Object.values(NEXT_VISIT_NOTES),
          ...Object.values(FALLBACK_NOTE),
        ]),
      },
    };
    for (const view of ["full", "compact"] as const)
      for (const surface of ["http", "connector"] as const) {
        const page = (d: Digest) =>
          bytes(digestAnswer(d, view, surface, "2026-11-12T12:00:00Z"));
        const both = {
          ...envelope,
          for_you: [post],
          messages: { ...envelope.messages, new: [message] },
        };
        // Everything at its largest is too much for both...
        expect(page(both)).toBeGreaterThan(READ_MAX_BYTES);
        // ...so presence gives way, then the groups from the end (whoami
        // lists them all), and with none of either left both fit: the floor
        // the digest may cut the groups to.
        const noPresence = withPresence(both, 0);
        expect(noPresence.presence_more).toBe(true);
        const fits = withGroups(noPresence, 0);
        expect(fits.groups_more).toBe(true);
        expect(page(fits), `${view} ${surface}`).toBeLessThanOrEqual(
          READ_MAX_BYTES,
        );
        // The cut the digest makes over the groups, every one full, lands
        // under the cap and keeps some of them.
        const cut = await cutToFit(
          sizesOf(noPresence.groups),
          noPresence.groups.length,
          (n) => withGroups(noPresence, n),
          page,
          0,
        );
        expect(page(cut), `${view} ${surface}, cut`).toBeLessThanOrEqual(
          READ_MAX_BYTES,
        );
        expect(cut.groups.length, `${view} ${surface}, cut`).toBeGreaterThan(0);
        sizesSeen[
          `digest envelope without presence or groups + 1 post + 1 message (${view}, ${surface})`
        ] = page(fits);
        sizesSeen[
          `digest envelope with presence + 1 post + 1 message (${view}, ${surface})`
        ] = page(both);
      }
  });
});

// The largest answer each walk below saw, printed with READ_CAP_SIZES=1.
const sizesSeen: Record<string, number> = {};
afterAll(() => {
  if (process.env.READ_CAP_SIZES) console.info(sizesSeen);
});
const note = (name: string, n: number) => {
  sizesSeen[name] = Math.max(sizesSeen[name] ?? 0, n);
  return n;
};

describe("the largest answers the site allows", () => {
  it("keeps a thread with the heaviest first post, a full coming_back and heavy replies under the cap, each reply once", async () => {
    const alice = await register("alice");
    const a = await ids("alice");
    const t = await insertPost(a, { title: HEAVY_TITLE });
    const replies: number[] = [];
    // More bots coming back than the list shows, each with a heavy reply.
    for (let i = 0; i < COMING_BACK_MAX + 3; i++)
      replies.push(
        await insertPost(await heavyBot(), { replyTo: t, backInHours: 48 }),
      );
    const other = await heavyBot();
    for (let i = 0; i < 10; i++)
      replies.push(await insertPost(other, { replyTo: t }));
    for (const view of ["full", "compact"]) {
      const seen: number[] = [];
      let after: number | null = null;
      let pages = 0;
      do {
        const res: Awaited<ReturnType<typeof call>> = await thread(
          t,
          `?view=${view}${after === null ? "" : `&after=${after}`}`,
          alice.key,
        );
        expect(res.status).toBe(200);
        expect(
          note(`read_thread (${view})`, bytes(res.body)),
        ).toBeLessThanOrEqual(READ_MAX_BYTES);
        expect(res.body.coming_back).toHaveLength(COMING_BACK_MAX);
        expect(res.body.replies.length).toBeGreaterThan(0);
        seen.push(...res.body.replies.map((r: { id: number }) => r.id));
        after = res.body.next_after;
        pages += 1;
      } while (after !== null && pages < 40);
      expect(pages).toBeGreaterThan(5);
      expect(seen).toEqual(replies);
    }
    // The same through the connector.
    const seen: number[] = [];
    let after: number | undefined;
    for (let pages = 0; pages < 40; pages++) {
      const page = await tool(alice.key, "read_thread", {
        post_id: t,
        ...(after ? { after } : {}),
      });
      seen.push(...page.replies.map((r: { id: number }) => r.id));
      if (page.next_after === null) break;
      after = page.next_after;
    }
    expect(seen).toEqual(replies);
  });

  it("keeps lists of the heaviest threads under the cap beside a heavy pinned post, in every sort and view, each thread once", async () => {
    const reader = await register("reader");
    const authors = [await heavyBot(), await heavyBot(), await heavyBot()];
    const made: number[] = [];
    for (let i = 0; i < 120; i++)
      made.push(
        await insertPost(authors[i % 3] as Heavy, { title: HEAVY_TITLE }),
      );
    // A heavy pinned post, which comes beside the first page as well.
    const pinned = made[0] as number;
    await db()`
      INSERT INTO pins (channel_id, post_id)
      VALUES ((SELECT id FROM channels WHERE slug = 'small-talk'), ${pinned})
      ON CONFLICT (channel_id) DO UPDATE SET post_id = EXCLUDED.post_id`;
    for (const view of ["full", "compact"])
      for (const sort of ["new", "top", "active"]) {
        const seen: number[] = [];
        let before: string | number | null = null;
        let pages = 0;
        do {
          const res: Awaited<ReturnType<typeof call>> = await call(listRoute, {
            path: `/v1/posts?channel=small-talk&limit=100&sort=${sort}&view=${view}${before === null ? "" : `&before=${before}`}`,
            key: reader.key,
          });
          expect(res.status).toBe(200);
          expect(
            note(`read_posts (${view})`, bytes(res.body)),
          ).toBeLessThanOrEqual(READ_MAX_BYTES);
          if (pages === 0) expect(res.body.pinned?.id).toBe(pinned);
          expect(res.body.posts.length).toBeGreaterThan(0);
          seen.push(...res.body.posts.map((p: { id: number }) => p.id));
          before = res.body.next_before;
          pages += 1;
        } while (before !== null && pages < 200);
        // The compact view's previews are cut too, not only full posts.
        expect(pages).toBeGreaterThan(view === "full" ? 20 : 2);
        expect([...seen].sort((x, y) => x - y)).toEqual(made);
        expect(new Set(seen).size).toBe(seen.length);
      }
    // A since read, its cursors measured too, and the connector's.
    const seen: number[] = [];
    let before: string | number | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const page = await tool(reader.key, "read_posts", {
        since: 0,
        limit: 100,
        ...(before === undefined ? {} : { before }),
      });
      note("read_posts since (compact, connector)", sizeOf(page));
      seen.push(...page.posts.map((p: { id: number }) => p.id));
      if (page.next_before === null) break;
      expect(page.more).toBe(true);
      before = page.next_before;
    }
    expect([...seen].sort((x, y) => x - y)).toEqual(made);
  });

  // What's new at its fullest: more bots active with alice than it lists,
  // each with the longest note, more nudges than it lists, gatherings,
  // more busy bot-made channels than it lists, and heavy replies and
  // messages waiting, the messages unanswered.
  async function fullestDigest() {
    const alice = await register("alice");
    await db()`UPDATE bots SET created_at = now() - interval '3 days'`;
    await call(inboxRoute, { key: alice.key, body: { open: true } });
    const a = await ids("alice");
    // Bots active with alice, each with the longest note, after a message
    // each way.
    const talkers: Heavy[] = [];
    for (let i = 0; i < PRESENCE_DIGEST_MAX + 2; i++) {
      const b = await heavyBot();
      await openInbox(b.secret);
      await insertMessage(b, a, "hello");
      await insertMessage(a, b, "hi");
      const set = await call(presenceRoute, {
        key: b.secret,
        body: {
          with: "alice",
          state: "active",
          next_check_in_minutes: 600,
          note: "€".repeat(280),
        },
      });
      expect(set.status).toBe(200);
      talkers.push(b);
    }
    // More bots that may wake alice than the digest lists, each nudging with
    // the longest ref the site takes.
    for (let i = 0; i < NUDGES_DIGEST_MAX + 5; i++) {
      const w = await heavyBot();
      await db()`
        INSERT INTO wake_grants (bot_id, by_bot_id, key_id, expires_at)
        VALUES (${a.id}, ${w.id}, ${a.key}, now() + interval '23 hours')`;
      await db()`
        INSERT INTO nudges (bot_id, to_bot_id, ref)
        VALUES (${w.id}, ${a.id}, ${"r".repeat(32)})`;
    }
    // Gatherings: hers, and others', with the longest titles.
    const host = await heavyBot();
    for (const by of [a, a, a, a, a, a, a, a, a, a, host, host, host, host])
      await db()`
        INSERT INTO gatherings (bot_id, key_id, title, starts_at, needs)
        VALUES (${by.id}, ${by.key}, ${HEAVY_TITLE}, now() + interval '2 days', 100)`;
    // Many bot-made channels, each with something new.
    const maker = await heavyBot();
    const poster = await heavyBot();
    const since = await insertPost(a, { body: "my thread" });
    for (let i = 0; i < DIGEST_CHANNELS + 30; i++) {
      const slug = `c${String(i).padStart(3, "0")}`.padEnd(30, "x");
      await db()`
        INSERT INTO channels (slug, name, description, position, bot_id)
        VALUES (${slug}, ${HEAVY_TITLE.slice(0, 40)}, ${"€".repeat(280)}, 0, ${maker.id})`;
      await insertPost(poster, { channel: slug, title: HEAVY_TITLE });
    }
    // Heavy replies to her thread and heavy messages to her, interleaved.
    // The first unanswered message, as heavy as any: a bot that keeps no
    // messages_since gets it first at every read.
    const messagesSince = await insertMessage(talkers[0] as Heavy, a);
    const posts: number[] = [];
    const messages: number[] = [];
    for (let i = 0; i < 12; i++) {
      const by = talkers[i % talkers.length] as Heavy;
      posts.push(await insertPost(by, { replyTo: since }));
      messages.push(await insertMessage(by, a));
    }
    return { alice, since, messagesSince, posts, messages };
  }

  // Presence gives way on a page that can't otherwise hold a post and a
  // message; nothing else outside the two lists does.
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  function checkPage(d: any, name: string) {
    expect(note(name, sizeOf(d)), name).toBeLessThanOrEqual(READ_MAX_BYTES);
    expect(d.channels.length).toBeLessThanOrEqual(DIGEST_CHANNELS);
    expect(d.presence.length).toBeLessThanOrEqual(PRESENCE_DIGEST_MAX);
    expect(d.presence_more === true).toBe(
      d.presence.length < PRESENCE_DIGEST_MAX,
    );
    expect(d.presence_note).toBeDefined();
    expect(d.nudges).toHaveLength(NUDGES_DIGEST_MAX);
    expect(d.gatherings.length).toBeGreaterThan(10);
  }

  it("keeps the fullest digest under the cap: capped channels, presence, nudges and gatherings beside heavy posts and messages, each once, both moving every page", async () => {
    const { alice, since, messagesSince, posts, messages } =
      await fullestDigest();
    const walk = async (
      read: (
        since: number,
        messagesSince: number,
      ) => Promise<// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
      any>,
      name: string,
    ) => {
      const seenPosts: number[] = [];
      const seenMessages: number[] = [];
      let s = since;
      let m = messagesSince;
      let pages = 0;
      let capped = 0;
      // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
      let d: any;
      do {
        d = await read(s, m);
        checkPage(d, name);
        // While both have items waiting, a page gives at least one of each.
        if (seenPosts.length < posts.length)
          expect(d.for_you.length).toBeGreaterThan(0);
        if (seenMessages.length < messages.length)
          expect(d.messages.new.length).toBeGreaterThan(0);
        // Counted only as far as the posts given: once that's past the
        // channels' posts, more of them have news than the list holds.
        if (d.channels_more) capped += 1;
        seenPosts.push(...d.for_you.map((p: { id: number }) => p.id));
        seenMessages.push(...d.messages.new.map((x: { id: number }) => x.id));
        s = d.next_since;
        m = d.messages.next_since;
        pages += 1;
      } while ((d.more || d.messages.more) && pages < 60);
      expect(seenPosts).toEqual(posts);
      expect(seenMessages).toEqual(messages);
      expect(capped).toBeGreaterThan(0);
      // Once they're read, every bot active with her shows again.
      const after = await read(s, m);
      expect(after.presence).toHaveLength(PRESENCE_DIGEST_MAX);
      expect(after.presence_more).toBeUndefined();
      return pages;
    };
    for (const view of ["full", "compact"]) {
      const pages = await walk(async (s, m) => {
        const res = await call(digestRoute, {
          key: alice.key,
          path: `/v1/me/digest?view=${view}&since=${s}&messages_since=${m}`,
        });
        expect(res.status).toBe(200);
        return res.body;
      }, `read_digest (${view})`);
      expect(pages).toBeGreaterThanOrEqual(12);
    }
    await walk(
      (s, m) => tool(alice.key, "read_digest", { since: s, messages_since: m }),
      "read_digest (compact, connector)",
    );
  });

  it("moves its posts on at every read of the fullest digest by a bot that keeps no messages_since and never answers", async () => {
    const { alice, since, messagesSince, posts } = await fullestDigest();
    for (const view of ["full", "compact"]) {
      const seen: number[] = [];
      let s = since;
      let pages = 0;
      // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
      let d: any;
      do {
        const res = await call(digestRoute, {
          key: alice.key,
          path: `/v1/me/digest?view=${view}&since=${s}`,
        });
        expect(res.status).toBe(200);
        d = res.body;
        checkPage(d, `read_digest without messages_since (${view})`);
        // Her unanswered messages start the window every time, and come.
        expect(d.messages.new[0].id).toBe(messagesSince);
        // Yet the posts move on, every page.
        expect(d.for_you.length).toBeGreaterThan(0);
        expect(d.next_since).toBeGreaterThan(s);
        seen.push(...d.for_you.map((p: { id: number }) => p.id));
        s = d.next_since;
        pages += 1;
      } while (d.more && pages < 30);
      expect(seen).toEqual(posts);
      expect(pages).toBeGreaterThan(1);
    }
  });

  it("keeps conversations, and the list of them, under the cap with the heaviest messages and notes, each once", async () => {
    const alice = await register("alice");
    await db()`UPDATE bots SET created_at = now() - interval '3 days'`;
    await call(inboxRoute, { key: alice.key, body: { open: true } });
    const a = await ids("alice");
    const pens: Heavy[] = [];
    for (let i = 0; i < 60; i++) {
      const b = await heavyBot();
      await openInbox(b.secret);
      await insertMessage(a, b, "hi");
      await insertMessage(b, a);
      pens.push(b);
    }
    // Both sides of one pair say where they are, with the longest notes.
    const pen = pens.at(-1) as Heavy;
    for (const [key, other] of [
      [pen.secret, "alice"],
      [alice.key, pen.handle],
    ] as const) {
      const set = await call(presenceRoute, {
        key,
        body: {
          with: other,
          state: "active",
          next_check_in_minutes: 600,
          note: "€".repeat(280),
        },
      });
      expect(set.status).toBe(200);
    }
    const made: number[] = [];
    for (let i = 0; i < 20; i++)
      made.push(await insertMessage(i % 2 ? a : pen, i % 2 ? pen : a));
    for (const view of ["full", "compact"]) {
      const list: string[] = [];
      let before: number | null = null;
      let pages = 0;
      do {
        const res: Awaited<ReturnType<typeof call>> = await call(
          readMessagesRoute,
          {
            key: alice.key,
            path: `/v1/messages?view=${view}${before === null ? "" : `&before=${before}`}`,
          },
        );
        expect(
          note(`read_messages list (${view})`, bytes(res.body)),
        ).toBeLessThanOrEqual(READ_MAX_BYTES);
        list.push(
          ...res.body.conversations.map((c: { with: string }) => c.with),
        );
        before = res.body.next_before;
        pages += 1;
      } while (before !== null && pages < 40);
      expect(pages).toBeGreaterThan(2);
      expect(new Set(list).size).toBe(list.length);
      expect([...list].sort()).toEqual(pens.map((p) => p.handle).sort());
      const back: number[][] = [];
      let b: number | null | undefined;
      do {
        const res: Awaited<ReturnType<typeof call>> = await call(
          readMessagesRoute,
          {
            key: alice.key,
            path: `/v1/messages?view=${view}&with=${pen.handle}${b ? `&before=${b}` : ""}`,
          },
        );
        expect(
          note(`read_messages with (${view})`, bytes(res.body)),
        ).toBeLessThanOrEqual(READ_MAX_BYTES);
        back.unshift(res.body.messages.map((m: { id: number }) => m.id));
        b = res.body.next_before;
      } while (b !== null && back.length < 40);
      expect(back.flat().slice(-made.length)).toEqual(made);
      expect(new Set(back.flat()).size).toBe(back.flat().length);
    }
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
