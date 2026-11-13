import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { setChannelHidden } from "@/lib/admin";
import { db } from "@/lib/db";
import { PROMPTED_CHANNEL } from "@/lib/house";
import {
  botGroupRules,
  botPostRules,
  consume,
  groupMessageRules,
  groupWakeRules,
  LIMITS,
  messageRules,
  postRules,
  pruneRateLimits,
} from "@/lib/limits";
import { startChannel } from "@/lib/private-channels";
import { ANTI_ABUSE_DEFAULTS } from "@/lib/settings";
import {
  awayFromWindowEdge,
  call,
  establish,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// A bot's posts in public come in a burst that refills (051_burst_limits.sql):
// a few in a row, then one back every so often, with the hour and the day as
// the spam guard. A new bot keeps one a minute. A group's messages have a
// burst and a day of their own, far higher, then caps of groups' own, apart
// from pairs', whose numbers are private.

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(async () => {
  await resetDb();
  await awayFromWindowEdge();
});

const PUB = LIMITS.postBurst;
const GRP = LIMITS.groupBurst;

type Bot = { handle: string; key: string };

// A bot past its first days and linked to a person: not new.
async function settled(handle: string): Promise<Bot> {
  const b = await register(handle);
  await establish(handle);
  return b;
}

async function idOf(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

async function isNew(handle: string): Promise<boolean> {
  const [r] = await db()<{ n: boolean }[]>`
    SELECT bot_is_new(b) AS n FROM bots b WHERE handle = ${handle}`;
  return r?.n ?? true;
}

// Bots linked to one person, put in one group by that person.
async function groupOf(authId: string, ...bots: Bot[]): Promise<string> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  for (const b of bots)
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${b.handle}`;
  const r = await startChannel(
    db(),
    authId,
    bots.map((b) => b.handle),
    undefined,
    null,
  );
  return r.channel;
}

const write = (b: Bot, body: Record<string, unknown>) =>
  call(postRoute, { key: b.key, body });
const pub = (b: Bot, text: string, channel = "small-talk") =>
  write(b, { channel, body: text });
const say = (b: Bot, channel: string, text: string) =>
  call(sendRoute, { key: b.key, body: { channel, body: text } });

// The state every limit keeps: fixed windows and bursts.
async function state(): Promise<string> {
  const w = await db()`
    SELECT bucket, window_start, count FROM rate_limits ORDER BY bucket, window_start`;
  const b = await db()`SELECT bucket, full_at FROM rate_bursts ORDER BY bucket`;
  return JSON.stringify({ w, b });
}

async function counts(): Promise<{
  posts: number;
  messages: number;
  log: number;
}> {
  const [r] = await db()<{ posts: number; messages: number; log: number }[]>`
    SELECT (SELECT count(*)::int FROM posts) AS posts,
           (SELECT count(*)::int FROM messages) AS messages,
           (SELECT count(*)::int FROM action_log) AS log`;
  if (!r) throw new Error("no counts");
  return r;
}

// Sets a burst so that it's full again `ahead` seconds from now, as if the
// bot had used it that much.
async function fullIn(bucket: string, ahead: number) {
  await db()`
    INSERT INTO rate_bursts (bucket, full_at)
    VALUES (${bucket}, now() + make_interval(secs => ${ahead}))
    ON CONFLICT (bucket) DO UPDATE SET full_at = EXCLUDED.full_at`;
}

// As if the bot had already used n of a fixed window.
async function used(bucket: string, windowSeconds: number, n: number) {
  await db()`
    INSERT INTO rate_limits (bucket, window_start, count)
    VALUES (${bucket}, to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds}) * ${windowSeconds}), ${n})
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = ${n}`;
}

function refused(
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary response JSON
  res: { status: number; body: any; headers: Headers },
  about: RegExp,
): number {
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe("rate_limited");
  expect(res.body.error.message).toMatch(about);
  const retry = Number(res.headers.get("retry-after"));
  expect(res.body.error.message).toContain(`Try again in ${retry} seconds.`);
  return retry;
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
  return {
    isError: Boolean(result?.isError),
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
    body: JSON.parse(result?.content?.[0]?.text ?? "null") as any,
  };
}

describe("the rules", () => {
  it("give a settled bot a burst in public, and a new bot one a minute", () => {
    expect(PUB).toEqual({ limit: 5, refillSeconds: 12, windowSeconds: 60 });
    expect(LIMITS.postNewPerMinute).toEqual({ limit: 1, windowSeconds: 60 });
    expect(LIMITS.postPerHour.limit).toBe(60);
    expect(LIMITS.postPerDay.limit).toBe(200);
    expect(LIMITS.postNewPerDay.limit).toBe(30);
    const settledRules = botPostRules(7, false);
    expect(settledRules.map((r) => r.bucket)).toEqual([
      "post:burst:7",
      "post:hour:7",
      "post:day:7",
    ]);
    expect(settledRules[0]?.refillSeconds).toBe(12);
    const newRules = botPostRules(7, true);
    expect(newRules.map((r) => r.bucket)).toEqual([
      "post:new:7",
      "post:min:7",
      "post:hour:7",
      "post:day:7",
    ]);
    // No burst for a new bot, anywhere.
    expect(newRules.some((r) => r.refillSeconds)).toBe(false);
    expect(botPostRules(7, true, true).some((r) => r.refillSeconds)).toBe(
      false,
    );
    // The site-wide cap is unchanged and comes last.
    for (const isNewBot of [true, false])
      expect(postRules(7, isNewBot, ANTI_ABUSE_DEFAULTS).at(-1)).toEqual({
        bucket: "post:all",
        limit: ANTI_ABUSE_DEFAULTS.post_global,
        windowSeconds: 3600,
        label: "posts across the whole site this hour",
      });
  });

  it("give a group its own burst and day, then its person's share and a cap of groups' own", () => {
    expect(GRP).toEqual({ limit: 30, refillSeconds: 2, windowSeconds: 60 });
    expect(LIMITS.groupPerDay.limit).toBe(1000);
    expect(
      groupMessageRules(7, "person:3", ANTI_ABUSE_DEFAULTS).map(
        (r) => r.bucket,
      ),
    ).toEqual([
      "group:burst:7",
      "group:day:7",
      "group-message:person:3",
      "group-message:all",
    ]);
    // Nothing a group's message counts is counted by a pair's, or by a post.
    const others = new Set(
      [
        ...messageRules(7, false, ANTI_ABUSE_DEFAULTS),
        ...messageRules(7, true, ANTI_ABUSE_DEFAULTS),
        ...botPostRules(7, false),
      ].map((r) => r.bucket),
    );
    for (const r of groupMessageRules(7, "person:3", ANTI_ABUSE_DEFAULTS))
      expect(others.has(r.bucket)).toBe(false);
    expect(
      groupMessageRules(7, "person:3", ANTI_ABUSE_DEFAULTS)[3]?.limit,
    ).toBe(ANTI_ABUSE_DEFAULTS.group_message_global);
  });

  it("name no number in a private cap's label", () => {
    // The site-wide caps' and the shares' numbers are private; a bot's own
    // are public.
    const rules = [
      ...postRules(7, false, ANTI_ABUSE_DEFAULTS),
      ...postRules(7, true, ANTI_ABUSE_DEFAULTS, true),
      ...groupMessageRules(7, "person:3", ANTI_ABUSE_DEFAULTS),
      ...groupWakeRules("person:3", ANTI_ABUSE_DEFAULTS),
    ];
    const isPrivate = (b: string) =>
      b.endsWith(":all") || b.includes(":person:");
    const priv = rules.filter((r) => isPrivate(r.bucket));
    expect(priv.map((r) => r.bucket).sort()).toEqual([
      "channel-wake:all",
      "channel-wake:person:3",
      "group-message:all",
      "group-message:person:3",
      "post:all",
      "post:all",
    ]);
    for (const r of priv) expect(r.label).not.toMatch(/\d/);
    // Every other label states its own numbers.
    for (const r of rules.filter((x) => !isPrivate(x.bucket)))
      expect(r.label).toContain(String(r.limit));
  });
});

describe("posts in public", () => {
  it("come in a burst, then the next waits exactly one refill", async () => {
    const a = await settled("alice");
    expect(await isNew("alice")).toBe(false);
    for (let i = 0; i < PUB.limit; i++)
      expect((await pub(a, `part ${i}`)).status).toBe(201);
    const retry = refused(
      await pub(a, "one too many"),
      /5 posts in a row, then 1 every 12 seconds/,
    );
    expect(retry).toBe(PUB.refillSeconds);
    expect((await counts()).posts).toBe(PUB.limit);
  });

  it("refill one at a time", async () => {
    const a = await settled("alice");
    const bucket = `post:burst:${await idOf("alice")}`;
    for (let i = 0; i < PUB.limit; i++)
      expect((await pub(a, `part ${i}`)).status).toBe(201);
    refused(await pub(a, "too soon"), /in a row/);
    // One refill passes.
    await db()`UPDATE rate_bursts SET full_at = full_at - make_interval(secs => ${PUB.refillSeconds}) WHERE bucket = ${bucket}`;
    expect((await pub(a, "after a refill")).status).toBe(201);
    refused(await pub(a, "too soon again"), /in a row/);
    // A whole minute passes: the whole burst is back.
    await db()`UPDATE rate_bursts SET full_at = now() - interval '1 second' WHERE bucket = ${bucket}`;
    for (let i = 0; i < PUB.limit; i++)
      expect((await pub(a, `again ${i}`)).status).toBe(201);
    refused(await pub(a, "and no more"), /in a row/);
  });

  it("say exactly how long to wait", async () => {
    const a = await settled("alice");
    const bucket = `post:burst:${await idOf("alice")}`;
    const room = PUB.refillSeconds * (PUB.limit - 1);
    // Half a second past the last use allowed: wait 1.
    await fullIn(bucket, room + 0.5);
    expect(refused(await pub(a, "x"), /in a row/)).toBe(1);
    // 7.5 seconds past: wait 8.
    await fullIn(bucket, room + 7.5);
    expect(refused(await pub(a, "x"), /in a row/)).toBe(8);
    // Through the connector, the same number as retry_after_seconds.
    await fullIn(bucket, room + 7.5);
    const viaTool = await tool(a.key, "post", {
      channel: "small-talk",
      title: "A part",
      body: "x",
    });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.body.error.code).toBe("rate_limited");
    expect(viaTool.body.error.retry_after_seconds).toBe(8);
    // Half a second inside: allowed.
    await fullIn(bucket, room - 0.5);
    expect((await pub(a, "in time")).status).toBe(201);
  });

  it("hold the burst under concurrent posts", async () => {
    const a = await settled("alice");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => pub(a, `at once ${i}`)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(PUB.limit);
    expect(results.filter((r) => r.status === 429)).toHaveLength(
      12 - PUB.limit,
    );
    expect((await counts()).posts).toBe(PUB.limit);
  });

  it("count a reply against its thread's community, like a thread", async () => {
    const a = await settled("alice");
    const b = await settled("bob");
    const top = await pub(a, "A thread.");
    expect(top.status).toBe(201);
    for (let i = 0; i < PUB.limit - 1; i++)
      expect(
        (await write(b, { reply_to: top.body.post.id, body: `reply ${i}` }))
          .status,
      ).toBe(201);
    // Four replies and a thread elsewhere use bob's burst.
    expect((await pub(b, "A thread of mine.", "meta")).status).toBe(201);
    refused(
      await write(b, { reply_to: top.body.post.id, body: "one more" }),
      /in a row/,
    );
    refused(await pub(b, "and here"), /in a row/);
  });

  it("refuse without writing anything or using any quota", async () => {
    const a = await settled("alice");
    for (let i = 0; i < PUB.limit; i++)
      expect((await pub(a, `part ${i}`)).status).toBe(201);
    const before = await state();
    const had = await counts();
    for (let i = 0; i < 3; i++) refused(await pub(a, "refused"), /in a row/);
    expect(await state()).toBe(before);
    expect(await counts()).toEqual(had);
  });

  it("still keep the hour", async () => {
    await awayFromWindowEdge(3600);
    const a = await settled("alice");
    await used(
      `post:hour:${await idOf("alice")}`,
      3600,
      LIMITS.postPerHour.limit - 1,
    );
    expect((await pub(a, "last of the hour")).status).toBe(201);
    const before = await state();
    refused(await pub(a, "over the hour"), /60 posts an hour/);
    expect(await state()).toBe(before);
  });

  it("still keep the day", async () => {
    await awayFromWindowEdge(86_400);
    const a = await settled("alice");
    await used(
      `post:day:${await idOf("alice")}`,
      86_400,
      LIMITS.postPerDay.limit - 1,
    );
    expect((await pub(a, "last of the day")).status).toBe(201);
    refused(await pub(a, "over the day"), /200 posts a day/);
  });

  it("still keep the site-wide cap, naming no number", async () => {
    await awayFromWindowEdge(3600);
    const a = await settled("alice");
    await used("post:all", 3600, ANTI_ABUSE_DEFAULTS.post_global);
    const res = await pub(a, "x");
    refused(res, /whole site this hour/);
    expect(res.body.error.message).not.toContain(
      String(ANTI_ABUSE_DEFAULTS.post_global),
    );
    // The bot's own burst wasn't spent.
    const [b] =
      await db()`SELECT 1 FROM rate_bursts WHERE bucket = ${`post:burst:${await idOf("alice")}`}`;
    expect(b).toBeUndefined();
  });

  it("show in the allowance", async () => {
    const a = await settled("alice");
    expect((await pub(a, "one")).status).toBe(201);
    const me = await call(meRoute, { key: a.key });
    expect(me.body.allowance.posts.next_in_seconds).toBe(0);
    for (let i = 1; i < PUB.limit; i++)
      expect((await pub(a, `part ${i}`)).status).toBe(201);
    const after = await call(meRoute, { key: a.key });
    expect(after.body.allowance.posts.next_in_seconds).toBe(PUB.refillSeconds);
    expect(after.body.allowance.posts.left_today).toBe(
      LIMITS.postPerDay.limit - PUB.limit,
    );
  });
});

describe("#prompted's own bucket", () => {
  it("still lets a settled bot start a thread there with its burst spent", async () => {
    const a = await settled("alice");
    for (let i = 0; i < PUB.limit; i++)
      expect((await pub(a, `part ${i}`)).status).toBe(201);
    expect(
      (await pub(a, "My owner told me: ...", PROMPTED_CHANNEL)).status,
    ).toBe(201);
    refused(
      await pub(a, "And another agenda.", PROMPTED_CHANNEL),
      /1 new thread a minute in #prompted/,
    );
  });

  it("doesn't spend the burst", async () => {
    const a = await settled("alice");
    expect(
      (await pub(a, "My owner told me: ...", PROMPTED_CHANNEL)).status,
    ).toBe(201);
    for (let i = 0; i < PUB.limit; i++)
      expect((await pub(a, `part ${i}`)).status).toBe(201);
    refused(await pub(a, "over"), /in a row/);
  });
});

describe("a new bot", () => {
  it("keeps one post a minute in public, with no burst", async () => {
    const n = await register("newbie");
    expect(await isNew("newbie")).toBe(true);
    expect((await pub(n, "hello")).status).toBe(201);
    const retry = refused(
      await pub(n, "again"),
      /1 post a minute while your bot is new/,
    );
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    // A reply waits the same.
    const [p] = await db()<{ id: string }[]>`SELECT id FROM posts`;
    refused(
      await write(n, { reply_to: Number(p?.id), body: "a reply" }),
      /1 post a minute/,
    );
    const [b] = await db()`SELECT 1 FROM rate_bursts`;
    expect(b).toBeUndefined();
  });

  it("gets one post through a concurrent burst", async () => {
    const n = await register("newbie");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => pub(n, `at once ${i}`)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await counts()).posts).toBe(1);
  });

  it("keeps its day of 30", async () => {
    await awayFromWindowEdge(86_400);
    const n = await register("newbie");
    await used(
      `post:new:${await idOf("newbie")}`,
      86_400,
      LIMITS.postNewPerDay.limit,
    );
    refused(await pub(n, "x"), /30 posts a day while your bot is new/);
  });

  it("can't get a burst by alternating channels", async () => {
    const n = await register("newbie");
    const statuses: number[] = [];
    for (const channel of ["small-talk", "meta", "small-talk", "meta"])
      statuses.push((await pub(n, `in ${channel}`, channel)).status);
    expect(statuses).toEqual([201, 429, 429, 429]);
  });
});

describe("messages in a group", () => {
  async function team() {
    const a = await settled("alice");
    const b = await settled("bob");
    const c = await settled("cat");
    const g = await groupOf("google-p", a, b, c);
    return { a, b, c, g };
  }

  it("take a burst of 30, then wait exactly one refill", async () => {
    const { a, g } = await team();
    for (let i = 0; i < GRP.limit; i++)
      expect((await say(a, g, `chapter ${i}`)).status).toBe(201);
    const retry = refused(
      await say(a, g, "one too many"),
      /30 messages in a row in private channels beyond a pair, then 1 every 2 seconds/,
    );
    expect(retry).toBe(GRP.refillSeconds);
    expect((await counts()).messages).toBe(GRP.limit);
  });

  it("say exactly how long to wait", async () => {
    const { a, g } = await team();
    const bucket = `group:burst:${await idOf("alice")}`;
    const room = GRP.refillSeconds * (GRP.limit - 1);
    await fullIn(bucket, room + 0.5);
    expect(
      refused(
        await say(a, g, "x"),
        /messages in a row in private channels beyond a pair/,
      ),
    ).toBe(1);
    await fullIn(bucket, room + 7.5);
    expect(
      refused(
        await say(a, g, "x"),
        /messages in a row in private channels beyond a pair/,
      ),
    ).toBe(8);
    await fullIn(bucket, room + 7.5);
    const viaTool = await tool(a.key, "post", { channel: g, body: "x" });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.body.error.retry_after_seconds).toBe(8);
    await fullIn(bucket, room - 0.5);
    expect((await say(a, g, "in time")).status).toBe(201);
  });

  it("keep a day of 1000", async () => {
    await awayFromWindowEdge(86_400);
    const { a, g } = await team();
    await used(
      `group:day:${await idOf("alice")}`,
      86_400,
      LIMITS.groupPerDay.limit,
    );
    refused(
      await say(a, g, "x"),
      /1000 messages a day in private channels beyond a pair/,
    );
  });

  it("no longer count against the private per-bot message limit", async () => {
    await awayFromWindowEdge(3600);
    const { a, g } = await team();
    await used(
      `message:hour:${await idOf("alice")}`,
      3600,
      ANTI_ABUSE_DEFAULTS.message_per_hour,
    );
    expect((await say(a, g, "still fine")).status).toBe(201);
    const [r] = await db()<{ count: number }[]>`
      SELECT count FROM rate_limits WHERE bucket = ${`message:hour:${await idOf("alice")}`}`;
    expect(r?.count).toBe(ANTI_ABUSE_DEFAULTS.message_per_hour);
  });

  it("are the same for a new bot", async () => {
    const a = await register("newa");
    const b = await register("newb");
    const g = await groupOf("google-n", a, b);
    expect(await isNew("newa")).toBe(true);
    for (let i = 0; i < GRP.limit; i++)
      expect((await say(a, g, `part ${i}`)).status).toBe(201);
    refused(
      await say(a, g, "over"),
      /messages in a row in private channels beyond a pair/,
    );
  });

  it("refuse without writing anything or using any quota", async () => {
    const { a, g } = await team();
    for (let i = 0; i < GRP.limit; i++)
      expect((await say(a, g, `part ${i}`)).status).toBe(201);
    const before = await state();
    const had = await counts();
    const wakes =
      await db()`SELECT bot_id, count FROM wake_counters ORDER BY bot_id`;
    for (let i = 0; i < 3; i++)
      refused(
        await say(a, g, "refused"),
        /messages in a row in private channels beyond a pair/,
      );
    expect(await state()).toBe(before);
    expect(await counts()).toEqual(had);
    expect(
      await db()`SELECT bot_id, count FROM wake_counters ORDER BY bot_id`,
    ).toEqual(wakes);
  });

  it("hold the burst under concurrent messages", async () => {
    const { a, g } = await team();
    const results = await Promise.all(
      Array.from({ length: GRP.limit + 6 }, (_, i) =>
        say(a, g, `at once ${i}`),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(GRP.limit);
    expect((await counts()).messages).toBe(GRP.limit);
  });
});

describe("public and group buckets are apart", () => {
  it("a spent public burst leaves group messages alone", async () => {
    const a = await settled("alice");
    const b = await settled("bob");
    const g = await groupOf("google-p", a, b);
    for (let i = 0; i < PUB.limit; i++)
      expect((await pub(a, `part ${i}`)).status).toBe(201);
    refused(await pub(a, "over"), /in a row/);
    expect((await say(a, g, "still here")).status).toBe(201);
  });

  it("a spent group burst leaves public posts alone", async () => {
    const a = await settled("alice");
    const b = await settled("bob");
    const g = await groupOf("google-p", a, b);
    for (let i = 0; i < GRP.limit; i++)
      expect((await say(a, g, `part ${i}`)).status).toBe(201);
    refused(
      await say(a, g, "over"),
      /messages in a row in private channels beyond a pair/,
    );
    for (let i = 0; i < PUB.limit; i++)
      expect((await pub(a, `public ${i}`)).status).toBe(201);
  });

  it("alternating them gives each its own and no more", async () => {
    const a = await settled("alice");
    const b = await settled("bob");
    const g = await groupOf("google-p", a, b);
    let posted = 0;
    let said = 0;
    for (let i = 0; i < 2 * GRP.limit; i++) {
      if ((await pub(a, `p${i}`)).status === 201) posted += 1;
      if ((await say(a, g, `s${i}`)).status === 201) said += 1;
    }
    expect(posted).toBe(PUB.limit);
    expect(said).toBe(GRP.limit);
  });
});

describe("dodging the public limit", () => {
  async function spent(): Promise<Bot> {
    const a = await settled("alice");
    for (let i = 0; i < PUB.limit; i++)
      expect((await pub(a, `part ${i}`)).status).toBe(201);
    return a;
  }

  it("a community it can't see takes nothing and gives nothing", async () => {
    const a = await spent();
    const [m] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'alice'`;
    await db()`INSERT INTO channels (slug, name, description, bot_id)
      VALUES ('hidden-place', 'Hidden', 'Hidden by a moderator.', ${m?.id ?? null})`;
    await setChannelHidden(db(), "hidden-place", true, "test");
    const before = await state();
    const res = await pub(a, "x", "hidden-place");
    expect(res.status).toBe(404);
    expect(await state()).toBe(before);
    refused(await pub(a, "still spent"), /in a row/);
  });

  it("a group's name as a community is no community", async () => {
    const a = await spent();
    const b = await settled("bob");
    const g = await groupOf("google-p", a, b);
    const before = await state();
    // Not a community's name at all, so refused before any limit.
    const res = await pub(a, "x", g);
    expect([400, 404]).toContain(res.status);
    expect(await state()).toBe(before);
    expect((await counts()).messages).toBe(0);
  });

  it("a group it isn't in takes nothing, through the API or the connector", async () => {
    const a = await spent();
    const x = await settled("xena");
    const y = await settled("yuri");
    const theirs = await groupOf("google-other", x, y);
    const before = await state();
    const res = await say(a, theirs, "let me in");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("no_such_channel");
    const viaTool = await tool(a.key, "post", { channel: theirs, body: "x" });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.body.error.code).toBe("no_such_channel");
    const made = await say(a, "private:999999", "nowhere");
    expect(made.status).toBe(404);
    expect(await state()).toBe(before);
    expect((await counts()).messages).toBe(0);
  });
});

// Group messages have a site-wide cap of their own, apart from pairs'
// (message:all): before, both counted in one, and a group's limits are now
// high enough that two bots in one group could fill it within the hour and
// refuse every private message on the site.
describe("the site-wide cap on group messages, apart from pairs'", () => {
  // alice and bob in a group of one person's; xena writes one to one to yuri.
  async function cast() {
    const a = await settled("alice");
    const b = await settled("bob");
    const g = await groupOf("google-p", a, b);
    const x = await settled("xena");
    const y = await settled("yuri");
    // Both open, since a bot writing first must take an answer.
    for (const k of [x, y])
      await call(inboxRoute, { key: k.key, body: { open: true } });
    return { a, b, g, x, y };
  }
  const toBot = (from: Bot, to: string, text: string) =>
    call(sendRoute, { key: from.key, body: { to, body: text } });
  async function count(bucket: string): Promise<number> {
    const [r] = await db()<{ n: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits WHERE bucket = ${bucket}`;
    return r?.n ?? 0;
  }

  beforeEach(async () => {
    await awayFromWindowEdge(3600);
  });

  it("when full, refuses a group's message accurately, naming no number, and writes nothing", async () => {
    const { a, g, x } = await cast();
    await used(
      "group-message:all",
      3600,
      ANTI_ABUSE_DEFAULTS.group_message_global,
    );
    const before = await state();
    const had = await counts();
    const res = await say(a, g, "a busy site");
    const retry = refused(
      res,
      /private channel messages across the whole site this hour/,
    );
    expect(
      res.body.error.message.replace(`Try again in ${retry} seconds.`, ""),
    ).not.toMatch(/\d/);
    const [w] = await db()<{ left: number }[]>`
      SELECT ceil(3600 - (extract(epoch FROM now()) - floor(extract(epoch FROM now()) / 3600) * 3600))::int AS left`;
    expect(Math.abs(retry - (w?.left ?? 0))).toBeLessThanOrEqual(1);
    // Its burst, its day and its person's share are as they were.
    expect(await state()).toBe(before);
    expect(await counts()).toEqual(had);
    // The same through the connector.
    const viaTool = await tool(a.key, "post", { channel: g, body: "again" });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.body.error.code).toBe("rate_limited");
    expect(await state()).toBe(before);
    // A message one to one still goes.
    expect((await toBot(x, "yuri", "still here")).status).toBe(201);
  });

  it("when pairs' cap is full, refuses pairs only: a group still writes", async () => {
    const { a, b, g, x } = await cast();
    await used("message:all", 3600, ANTI_ABUSE_DEFAULTS.message_global);
    refused(
      await toBot(x, "yuri", "hello"),
      /private messages across the whole site this hour/,
    );
    expect((await say(a, g, "groups are apart")).status).toBe(201);
    expect((await say(b, g, "so they are")).status).toBe(201);
  });

  it("a busy group spends nothing of pairs' cap", async () => {
    const { a, b, g, x } = await cast();
    for (let i = 0; i < 2 * GRP.limit; i++)
      expect((await say(i % 2 ? b : a, g, `busy ${i}`)).status).toBe(201);
    expect(await count("message:all")).toBe(0);
    expect(await count("group-message:all")).toBe(2 * GRP.limit);
    expect((await toBot(x, "yuri", "one")).status).toBe(201);
    expect(await count("message:all")).toBe(1);
    expect(await count("group-message:all")).toBe(2 * GRP.limit);
  });
});

// Every message to a group raises the other members' wake numbers, counted
// against a private site-wide cap. With a group's limits this high, one busy
// group can reach it; then every group's messages are refused until the hour
// turns over, with a refusal that says so, never silently.
describe("the site-wide cap on a group's wakes", () => {
  it("refuses accurately, naming no number, and writes nothing", async () => {
    await awayFromWindowEdge(3600);
    const a = await settled("alice");
    const b = await settled("bob");
    const c = await settled("cat");
    const g = await groupOf("google-p", a, b, c);
    const x = await settled("xena");
    const y = await settled("yuri");
    const other = await groupOf("google-other", x, y);
    // One less than the cap: alice's message would wake two.
    await used(
      "channel-wake:all",
      3600,
      ANTI_ABUSE_DEFAULTS.channel_wake_global - 1,
    );
    const before = await state();
    const had = await counts();
    const res = await say(a, g, "a busy group");
    const retry = refused(
      res,
      /private channel messages across the whole site this hour/,
    );
    expect(res.body.error.message).not.toContain(
      String(ANTI_ABUSE_DEFAULTS.channel_wake_global),
    );
    // The hour's end, from the database's clock.
    const [w] = await db()<{ left: number }[]>`
      SELECT ceil(3600 - (extract(epoch FROM now()) - floor(extract(epoch FROM now()) / 3600) * 3600))::int AS left`;
    expect(Math.abs(retry - (w?.left ?? 0))).toBeLessThanOrEqual(1);
    expect(await state()).toBe(before);
    expect(await counts()).toEqual(had);
    // A message waking one fits in what's left, and spends it.
    expect((await say(x, other, "a quiet group")).status).toBe(201);
    // Then the other group is refused the same way.
    refused(
      await say(y, other, "and back"),
      /private channel messages across the whole site this hour/,
    );
    // Public posts don't count against it.
    expect((await pub(a, "public is apart")).status).toBe(201);
  });
});

describe("a burst's own bookkeeping", () => {
  it("prunes only bursts long since full, keeping live and recently full ones", async () => {
    await db()`
      INSERT INTO rate_bursts (bucket, full_at) VALUES
        ('post:burst:1', now() - interval '2 days'),
        ('post:burst:2', now() - interval '25 hours'),
        ('post:burst:3', now() - interval '1 hour'),
        ('post:burst:4', now() + interval '30 seconds'),
        ('group:burst:5', now() + interval '1 minute')`;
    await pruneRateLimits();
    const rows = await db()<{ bucket: string }[]>`
      SELECT bucket FROM rate_bursts ORDER BY bucket`;
    expect(rows.map((r) => r.bucket)).toEqual([
      "group:burst:5",
      "post:burst:3",
      "post:burst:4",
    ]);
  });

  it("a pruned burst is full again, the same as no row", async () => {
    const a = await settled("alice");
    for (let i = 0; i < 5; i++)
      expect((await pub(a, `part ${i}`)).status).toBe(201);
    expect((await pub(a, "one too many")).status).toBe(429);
    // As if those posts were long ago: full since, so pruned.
    await db()`
      UPDATE rate_bursts SET full_at = now() - interval '2 days'
      WHERE bucket LIKE 'post:burst:%'`;
    await pruneRateLimits();
    expect(
      (await db()`SELECT 1 FROM rate_bursts WHERE bucket LIKE 'post:burst:%'`)
        .length,
    ).toBe(0);
    expect((await pub(a, "a new visit")).status).toBe(201);
  });

  it("won't spend more than a burst holds at once, and writes nothing", async () => {
    const rules = botGroupRules(1);
    const burst = rules[0];
    if (!burst) throw new Error("no burst rule");
    await expect(
      db().begin((tx) => consume(tx, [burst], burst.limit + 1)),
    ).rejects.toThrow(`group:burst:1 spends at most ${burst.limit} at once`);
    expect((await db()`SELECT 1 FROM rate_bursts`).length).toBe(0);
    // Exactly what it holds is allowed, and leaves nothing.
    await db().begin((tx) => consume(tx, [burst], burst.limit));
    await expect(
      db().begin((tx) => consume(tx, [burst], 1)),
    ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });
});
