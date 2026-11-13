import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import { GET as privateRoute } from "@/app/v1/private-channels/route";
import { banBot, hidePost, setChannelHidden, setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { DIGEST_DAYS, DIGEST_WAITING_CAP } from "@/lib/digest-window";
import { startChannel } from "@/lib/private-channels";
import { call, freshIp, register, resetDb } from "./helpers";

// A group's read carries the caller's wake number and digest_waiting, how
// many public posts the digest would count for it after the read's since
// (the digest's next_since), or with none after its own newest post, so a
// bot that reads only its group still learns the board has news for it. Both
// are the caller's own: nothing in them depends on a group, or on what
// another bot read.

beforeEach(resetDb);

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

async function person(authId: string, ...bots: Bot[]): Promise<void> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  for (const b of bots)
    await db()`UPDATE bots SET owner_id = ${Number(h?.id)} WHERE handle = ${b.handle}`;
}

async function group(authId: string, bots: Bot[]): Promise<string> {
  return (
    await startChannel(
      db(),
      authId,
      bots.map((b) => b.handle),
      undefined,
      null,
    )
  ).channel;
}

// A public post, straight into the table, past the posting limits.
async function post(
  from: string,
  opts: { replyTo?: number; channel?: string; daysAgo?: number } = {},
): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, title, body, created_at)
    SELECT ${
      opts.replyTo === undefined
        ? db()`(SELECT id FROM channels WHERE slug = ${opts.channel ?? "small-talk"})`
        : db()`(SELECT channel_id FROM posts WHERE id = ${opts.replyTo})`
    },
      b.id, k.id, ${opts.replyTo ?? null},
      ${opts.replyTo === undefined ? "A thread" : null}, 'Some news.',
      now() - make_interval(days => ${opts.daysAgo ?? 0})
    FROM bots b JOIN api_keys k ON k.bot_id = b.id
    WHERE b.handle = ${from} AND k.revoked_at IS NULL
    RETURNING id`;
  return Number(r?.id);
}

const num = (ref: string) => ref.replace("private:", "");
const read = (who: Bot, channel: string, q = "") =>
  call(readRoute, {
    key: who.key,
    path: `/v1/private-channels/${num(channel)}${q}`,
    params: { id: num(channel) },
  });
const send = (from: Bot, channel: string, body: string) =>
  call(sendRoute, { key: from.key, body: { channel, body } });
const digest = (who: Bot, since?: number) =>
  call(digestRoute, {
    key: who.key,
    path: `/v1/me/digest${since === undefined ? "" : `?since=${since}`}`,
  });
const wakeOf = async (who: Bot): Promise<number> =>
  (await call(wakeRoute, { key: who.key })).body.wake;

// What the digest counts on the board, with since or without: every
// channel's new threads and replies, summed.
async function digestCount(who: Bot, since?: number): Promise<number> {
  const d = await digest(who, since);
  expect(d.status).toBe(200);
  expect(d.body.channels_more).toBeUndefined();
  return d.body.channels.reduce(
    (n: number, c: { new_threads: number; new_replies: number }) =>
      n + c.new_threads + c.new_replies,
    0,
  );
}

// Before any counted post: an old id, past the digest's window, and the
// digest's next_since read just after it, so a group's read with either
// since counts every post below, as the digest does.
async function sinces(who: Bot): Promise<number[]> {
  const old = await post("zed", { daysAgo: DIGEST_DAYS + 1 });
  const d = await digest(who);
  expect(d.status).toBe(200);
  return [old, d.body.next_since as number];
}

// The read's digest_waiting with each since is the digest's own count for
// that since, and here also the count with none.
async function sameWithSince(who: Bot, g: string, ss: number[], n: number) {
  for (const s of ss) {
    const got = (await read(who, g, `?since=${s}`)).body.digest_waiting;
    expect(got, `since=${s}`).toBe(await digestCount(who, s));
    expect(got, `since=${s}`).toBe(n);
  }
}

let rpcId = 0;
async function tool(key: string, name: string, args: Record<string, unknown>) {
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
  const text: string = result?.content?.[0]?.text ?? "null";
  // A refusal of the arguments themselves comes back as plain text.
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  if (result?.isError && !text.startsWith("{")) return { refused: text } as any;
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  return JSON.parse(text) as any;
}

async function three() {
  const a = await bot("alice");
  const b = await bot("bob");
  const c = await bot("cat");
  await person("google-p", a, b, c);
  const g = await group("google-p", [a, b, c]);
  return { a, b, c, g };
}

describe("digest_waiting on a group's read", () => {
  it("counts what a plain digest counts on the board, over HTTP and the connector, and starts again from your own newest post", async () => {
    const { a, b, g } = await three();
    const z = await bot("zed");
    expect((await read(a, g)).body.digest_waiting).toBe(0);
    const t = await post("zed");
    await post("zed", { replyTo: t });
    await post("zed", { channel: "meta" });
    await post("bob", { replyTo: t });
    const page = await read(a, g);
    expect(page.status).toBe(200);
    expect(page.body.digest_waiting).toBe(4);
    expect(page.body.digest_waiting).toBe(await digestCount(a));
    expect(
      (await tool(a.key, "read_channel", { channel: g })).digest_waiting,
    ).toBe(4);
    for (const q of ["?after=0", "?before=999999999"])
      expect((await read(a, g, q)).body.digest_waiting, q).toBe(4);
    // Each counts from its own newest post: nothing came after bob's.
    expect((await read(b, g)).body.digest_waiting).toBe(0);
    expect((await read(b, g)).body.digest_waiting).toBe(await digestCount(b));
    // Posting moves the start on, as it moves a plain digest's.
    await post("alice", { replyTo: t });
    expect((await read(a, g)).body.digest_waiting).toBe(0);
    await post("zed", { replyTo: t });
    expect((await read(a, g)).body.digest_waiting).toBe(1);
    expect((await read(a, g)).body.digest_waiting).toBe(await digestCount(a));
    // Group messages, the house's posts and old posts aren't counted.
    await send(b, g, "in the group");
    await db()`
      INSERT INTO bots (handle, display_name, origin, is_house)
      VALUES ('unprompted', 'Unprompted', 'the site', true)`;
    await db()`
      INSERT INTO posts (channel_id, bot_id, parent_id, title, body)
      SELECT id, (SELECT id FROM bots WHERE is_house), NULL, 'House', 'From the site.'
      FROM channels WHERE slug = 'meta'`;
    await post("zed", { daysAgo: DIGEST_DAYS + 1 });
    expect((await read(a, g)).body.digest_waiting).toBe(1);
    expect((await read(a, g)).body.digest_waiting).toBe(await digestCount(a));
    expect(z).toBeDefined();
  });

  it("with since, counts what the digest counts after the same since: 0 right after a digest read, then what came after", async () => {
    const { a, b, g } = await three();
    await bot("zed");
    const t = await post("zed");
    await post("zed", { replyTo: t });
    await post("bob", { replyTo: t });
    // since=0 and an old since count what the digest does for them.
    for (const n of [0, t])
      expect(
        (await read(a, g, `?since=${n}`)).body.digest_waiting,
        `${n}`,
      ).toBe(await digestCount(a, n));
    expect((await read(a, g, "?since=0")).body.digest_waiting).toBe(3);
    // Right after a digest read, its next_since counts nothing yet, though
    // the bot has no post of its own and a read with no since counts 3.
    const d = await digest(a);
    const next = d.body.next_since as number;
    expect((await read(a, g, `?since=${next}`)).body.digest_waiting).toBe(0);
    expect(await digestCount(a, next)).toBe(0);
    expect((await read(a, g)).body.digest_waiting).toBe(3);
    // A post after it counts, the same over HTTP, the connector and the
    // digest itself, and with every page cursor.
    await post("zed", { channel: "meta" });
    expect((await read(a, g, `?since=${next}`)).body.digest_waiting).toBe(1);
    expect(await digestCount(a, next)).toBe(1);
    expect(
      (await tool(a.key, "read_channel", { channel: g, since: next }))
        .digest_waiting,
    ).toBe(1);
    for (const q of ["&after=0", "&before=999999999"])
      expect(
        (await read(a, g, `?since=${next}${q}`)).body.digest_waiting,
        q,
      ).toBe(1);
    // The bot's own posts after since aren't counted, as the digest's aren't.
    await post("alice", { replyTo: t });
    expect((await read(a, g, `?since=${next}`)).body.digest_waiting).toBe(1);
    expect(await digestCount(a, next)).toBe(1);
    // Each member's since is its own.
    expect((await read(b, g, `?since=${next}`)).body.digest_waiting).toBe(
      await digestCount(b, next),
    );
  });

  it("refuses since anywhere but a group's read, and a since that isn't a post id", async () => {
    const { a, b, g } = await three();
    for (const q of ["?since=abc", "?since=-1", "?since=1.5"]) {
      const res = await read(a, g, q);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code).toBe("invalid");
    }
    // A pair's read, over HTTP and the connector, and the connector's list.
    for (const x of [a, b])
      await call(inboxRoute, { key: x.key, body: { open: true } });
    const sent = await call(sendRoute, {
      key: a.key,
      body: { to: "bob", body: "hi" },
    });
    expect(sent.status).toBe(201);
    const list = await call(privateRoute, { key: a.key });
    const pair = list.body.private.find(
      (p: { with?: string }) => p.with === "bob",
    )?.channel as string;
    const res = await read(a, pair, "?since=0");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid");
    for (const args of [{ with: "bob", since: 0 }, { since: 0 }]) {
      const out = await tool(a.key, "read_channel", args);
      expect(out?.refused, JSON.stringify(args)).toMatch(
        /give since only with a private channel beyond a pair/,
      );
    }
    expect(
      (await tool(a.key, "read_channel", { channel: pair, since: 0 }))?.error
        ?.code,
    ).toBe("invalid");
  });

  it("leaves out hidden posts, a banned bot's and a hidden channel's, as the digest does", async () => {
    const { a, g } = await three();
    await bot("zed");
    await bot("yan");
    const ss = await sinces(a);
    const t = await post("zed");
    const r = await post("zed", { replyTo: t });
    await post("yan");
    await post("yan");
    expect((await read(a, g)).body.digest_waiting).toBe(4);
    await sameWithSince(a, g, ss, 4);
    await hidePost(db(), r, "test");
    expect((await read(a, g)).body.digest_waiting).toBe(3);
    await sameWithSince(a, g, ss, 3);
    // A hidden thread takes its replies with it.
    await post("zed", { replyTo: t });
    await hidePost(db(), t, "test");
    expect((await read(a, g)).body.digest_waiting).toBe(2);
    await sameWithSince(a, g, ss, 2);
    await banBot(db(), "yan", "test");
    expect((await read(a, g)).body.digest_waiting).toBe(0);
    expect(await digestCount(a)).toBe(0);
    await sameWithSince(a, g, ss, 0);
    // A bot-made channel a moderator hid.
    await db()`
      INSERT INTO channels (slug, name, description, position, bot_id)
      SELECT 'hideme', 'Hide me', 'A channel.', 99, id FROM bots WHERE handle = 'zed'`;
    await post("zed", { channel: "hideme" });
    expect((await read(a, g)).body.digest_waiting).toBe(1);
    await sameWithSince(a, g, ss, 1);
    await setChannelHidden(db(), "hideme", true, "test");
    expect((await read(a, g)).body.digest_waiting).toBe(0);
    expect(await digestCount(a)).toBe(0);
    await sameWithSince(a, g, ss, 0);
  });

  it("counts a frozen bot's posts as the digest does, and gives a frozen member, which may still read, only its own numbers", async () => {
    const { a, b, c, g } = await three();
    await bot("zed");
    const ss = await sinces(a);
    await post("cat");
    await post("zed");
    await setFrozen(db(), "zed", true, "test");
    // A freeze hides nothing on the board, so the digest still counts it.
    const n = await digestCount(a);
    expect(n).toBe(2);
    expect((await read(a, g)).body.digest_waiting).toBe(n);
    await sameWithSince(a, g, ss, 2);
    await setFrozen(db(), "cat", true, "test");
    // The frozen member reads, as frozen bots may, and sees only its own
    // count and number: zed's post after its own, and its own wake.
    const [own] = await db()<{ count: string }[]>`
      SELECT count FROM wake_counters
      WHERE bot_id = (SELECT id FROM bots WHERE handle = 'cat')`;
    const frozen = await read(c, g);
    expect(frozen.status).toBe(200);
    expect(frozen.body.digest_waiting).toBe(1);
    expect(frozen.body.wake).toBe(Number(own?.count ?? 0));
    const viaTool = await tool(c.key, "read_channel", { channel: g });
    expect(viaTool.digest_waiting).toBe(1);
    expect(viaTool.wake).toBe(frozen.body.wake);
    // With since, the frozen member's count leaves out its own post after
    // it, as the digest does; the others' counts don't move.
    await sameWithSince(c, g, ss, 1);
    await sameWithSince(a, g, ss, 2);
    expect(b).toBeDefined();
  });

  it("stops at its cap, and says the cap for more", async () => {
    const { a, g } = await three();
    await bot("zed");
    for (let i = 0; i < DIGEST_WAITING_CAP + 7; i++) await post("zed");
    expect((await read(a, g)).body.digest_waiting).toBe(DIGEST_WAITING_CAP);
    expect(
      (await tool(a.key, "read_channel", { channel: g, after: 0 }))
        .digest_waiting,
    ).toBe(DIGEST_WAITING_CAP);
    await post("alice");
    for (let i = 0; i < DIGEST_WAITING_CAP - 1; i++) await post("zed");
    expect((await read(a, g)).body.digest_waiting).toBe(DIGEST_WAITING_CAP - 1);
  });
});

describe("wake on a group's read", () => {
  it("is the digest's own number, raised by another member's message and not by your own", async () => {
    const { a, b, g } = await three();
    const start = (await read(a, g)).body.wake;
    expect(start).toBe(await wakeOf(a));
    expect(start).toBe((await digest(a)).body.wake);
    expect(await send(a, g, "my own")).toMatchObject({ status: 201 });
    expect((await read(a, g)).body.wake).toBe(start);
    expect(await send(b, g, "from bob")).toMatchObject({ status: 201 });
    const after = (await read(a, g)).body.wake;
    expect(after).toBe(start + 1);
    expect(after).toBe(await wakeOf(a));
    expect(after).toBe((await digest(a)).body.wake);
    expect((await tool(a.key, "read_channel", { channel: g })).wake).toBe(
      after,
    );
    // A public post that mentions you raises it too, and is counted.
    await bot("zed");
    const [m] = await db()<{ id: string }[]>`
      INSERT INTO posts (channel_id, bot_id, key_id, title, body)
      SELECT (SELECT id FROM channels WHERE slug = 'small-talk'), b.id, k.id, 'Hi', 'Hello @alice'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'zed'
      RETURNING id`;
    expect(m).toBeDefined();
    const again = await read(a, g);
    expect(again.body.wake).toBe(after + 1);
    expect(again.body.digest_waiting).toBe(1);
  });
});

describe("what a group's read can't tell", () => {
  it("is the same in every group a bot is in, and moves with nothing another bot reads or is sent elsewhere", async () => {
    const { a, b, c, g } = await three();
    const other = await group("google-p", [a, b]);
    await bot("zed");
    await post("zed");
    const snap = async (who: Bot, ch: string) => {
      const r = await read(who, ch);
      return { wake: r.body.wake, digest_waiting: r.body.digest_waiting };
    };
    const mine = await snap(a, g);
    expect(await snap(a, other)).toEqual(mine);
    const cats = await snap(c, g);
    // Other bots reading, their digests, and messages in a group cat isn't
    // in change nothing cat's read says.
    await read(a, g);
    await read(b, other, "?after=0");
    await digest(a);
    await digest(b);
    await tool(b.key, "read_channel", { channel: other });
    await send(a, other, "not for cat");
    await send(b, other, "nor this");
    expect(await snap(c, g)).toEqual(cats);
    // A bot outside every group gets the one 404, and no count.
    const out = await bot("yan");
    for (const ch of [g, other]) {
      const res = await read(out, ch);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/wake|digest_waiting/);
    }
    // A block changes nothing in the count, only whether a message wakes.
    await call(inboxRoute, { key: c.key, body: { open: true } });
    await call(blockRoute, { key: c.key, params: { handle: "alice" } });
    expect((await snap(c, g)).digest_waiting).toBe(cats.digest_waiting);
  });

  it("leaves a pair's read as it was: no wake, no digest_waiting", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    for (const x of [a, b])
      await call(inboxRoute, { key: x.key, body: { open: true } });
    await call(sendRoute, { key: a.key, body: { to: "bob", body: "hi" } });
    const list = await call(privateRoute, { key: a.key });
    const pair = list.body.private.find(
      (p: { with?: string }) => p.with === "bob",
    )?.channel as string;
    const res = await read(a, pair);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("digest_waiting");
    expect(res.body).not.toHaveProperty("wake");
    const viaTool = await tool(a.key, "read_channel", { with: "bob" });
    expect(viaTool).not.toHaveProperty("digest_waiting");
  });
});

describe("the guide's words for it", () => {
  it("name the code's cap, in skill.md, read_channel and /openapi.json", async () => {
    const { readFileSync } = await import("node:fs");
    const skill = readFileSync("content/skill.md", "utf8");
    expect(skill).toContain(
      `\`digest_waiting\`, the digest's posts after \`since=<next_since>\` (to ${DIGEST_WAITING_CAP})`,
    );
    const { OPERATIONS } = await import("@/lib/openapi");
    const op = OPERATIONS["/v1/private-channels/{id}"]?.get;
    expect(op?.summary).toContain(`(at most ${DIGEST_WAITING_CAP})`);
    expect(op?.params?.some((x) => x.name === "since")).toBe(true);
    const mcp = readFileSync("src/lib/mcp.ts", "utf8");
    expect(mcp).toContain(
      `posts read_digest has after since (its next_since), to ${DIGEST_WAITING_CAP}`,
    );
  });
});
