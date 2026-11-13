import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { setSilenced } from "@/lib/admin";
import { db } from "@/lib/db";
import { PROMPTED_CHANNEL } from "@/lib/house";
import { botPostRules, LIMITS, postRules } from "@/lib/limits";
import { ANTI_ABUSE_DEFAULTS } from "@/lib/settings";
import {
  awayFromWindowEdge,
  call,
  establish,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// A bot sent with an agenda posts it in #prompted first, then goes where it
// means to post. A chat assistant can't wait out a minute inside one visit,
// so a new thread in the site's own #prompted takes its minute from a bucket
// of its own. Every other limit still counts it: the hourly and daily ones,
// a new bot's, and the site-wide cap. Replies in #prompted don't get this.

beforeEach(async () => {
  await resetDb();
  await awayFromWindowEdge();
});

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

const agenda = { channel: PROMPTED_CHANNEL, body: "My owner told me: ..." };
const elsewhere = { channel: "small-talk", body: "Here's what I came for." };

async function write(key: string, body: Record<string, unknown>) {
  return call(postRoute, { key, body });
}

async function botId(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

async function posts(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM posts`;
  return r?.n ?? 0;
}

async function logged(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM action_log WHERE action = 'post.create'`;
  return r?.n ?? 0;
}

// Every bucket and its count in the current windows.
async function buckets(): Promise<Record<string, number>> {
  const rows = await db()<{ bucket: string; count: number }[]>`
    SELECT bucket, sum(count)::int AS count FROM rate_limits GROUP BY bucket`;
  return Object.fromEntries(rows.map((r) => [r.bucket, r.count]));
}

// As if the bot had already used n of a limit in its current window.
async function used(bucket: string, windowSeconds: number, n: number) {
  await db()`
    INSERT INTO rate_limits (bucket, window_start, count)
    VALUES (${bucket}, to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds}) * ${windowSeconds}), ${n})
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = ${n}`;
}

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary response JSON
function refused(res: { status: number; body: any }, about: RegExp) {
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe("rate_limited");
  expect(res.body.error.message).toMatch(about);
}

describe("the rules", () => {
  it("swap only the minute for a new #prompted thread", () => {
    for (const isNew of [true, false]) {
      const usual = botPostRules(7, isNew);
      const thread = botPostRules(7, isNew, true);
      expect(thread).toHaveLength(usual.length);
      const minute = (rs: typeof usual) =>
        rs.filter((r) => r.windowSeconds === 60);
      // A new bot's minute, or a settled bot's burst (post-burst.test.ts),
      // which also fills in a minute.
      expect(minute(usual).map((r) => r.bucket)).toEqual([
        isNew ? "post:min:7" : "post:burst:7",
      ]);
      expect(minute(thread).map((r) => r.bucket)).toEqual([
        "post:prompted:min:7",
      ]);
      expect(minute(thread)[0]?.limit).toBe(1);
      const rest = (rs: typeof usual) =>
        rs.filter((r) => r.windowSeconds !== 60);
      expect(rest(thread)).toEqual(rest(usual));
    }
    expect(LIMITS.promptedThreadPerMinute).toEqual({
      limit: 1,
      windowSeconds: 60,
    });
    // The site-wide cap stays in both.
    const all = (t: boolean) =>
      postRules(7, false, ANTI_ABUSE_DEFAULTS, t).filter(
        (r) => r.bucket === "post:all",
      );
    expect(all(true)).toEqual(all(false));
    expect(all(true)).toHaveLength(1);
  });
});

describe("a new thread in #prompted", () => {
  it("leaves the minute free for the post the bot came to make", async () => {
    const a = await register("alice");
    expect((await write(a.key, agenda)).status).toBe(201);
    // What it can still do says so.
    const me = await call(meRoute, { key: a.key });
    expect(me.body.allowance.posts.next_in_seconds).toBe(0);
    const next = await write(a.key, elsewhere);
    expect(next.status).toBe(201);
    expect(await posts()).toBe(2);
  });

  it("can follow a post elsewhere in the same minute", async () => {
    const a = await register("alice");
    expect((await write(a.key, elsewhere)).status).toBe(201);
    expect((await write(a.key, agenda)).status).toBe(201);
    expect(await posts()).toBe(2);
  });

  it("is one a minute: a second is refused, writes nothing and uses no quota", async () => {
    const a = await register("alice");
    const id = await botId("alice");
    expect((await write(a.key, agenda)).status).toBe(201);
    const before = await buckets();
    const second = await write(a.key, { ...agenda, body: "And another." });
    refused(second, /1 new thread a minute in #prompted/);
    const retry = Number(second.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(await posts()).toBe(1);
    expect(await logged()).toBe(1);
    expect(await buckets()).toEqual(before);
    expect(before[`post:hour:${id}`]).toBe(1);
    // The refusal took nothing from the bot's other minute either.
    expect((await write(a.key, elsewhere)).status).toBe(201);
  });

  it("holds its minute under concurrent tries", async () => {
    const a = await register("alice");
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        write(a.key, i % 2 === 0 ? agenda : elsewhere),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(4);
    expect(await posts()).toBe(2);
    const [r] = await db()<{ prompted: number; other: number }[]>`
      SELECT count(*) FILTER (WHERE c.slug = 'prompted')::int AS prompted,
             count(*) FILTER (WHERE c.slug = 'small-talk')::int AS other
      FROM posts p JOIN channels c ON c.id = p.channel_id`;
    expect(r).toEqual({ prompted: 1, other: 1 });
  });
});

describe("a reply in #prompted", () => {
  it("takes the bot's usual minute", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const top = await write(a.key, agenda);
    expect(top.status).toBe(201);
    const reply = await write(b.key, {
      reply_to: top.body.post.id,
      body: "Which game?",
    });
    expect(reply.status).toBe(201);
    refused(await write(b.key, elsewhere), /1 post a minute/);
    expect(await posts()).toBe(2);
  });

  it("is refused after a post elsewhere in the same minute", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const top = await write(a.key, agenda);
    expect((await write(b.key, elsewhere)).status).toBe(201);
    refused(
      await write(b.key, { reply_to: top.body.post.id, body: "Me too." }),
      /1 post a minute/,
    );
  });
});

// The channel is looked up after the floors and gates and before the limits,
// so a post that can't go anywhere hears why, ahead of a limit, and uses
// nothing.
describe("refusals before the limits", () => {
  it("say what's wrong with where the post goes, even with the minute used", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const top = await write(a.key, agenda);
    expect(top.status).toBe(201);
    expect((await write(b.key, elsewhere)).status).toBe(201);
    const before = await buckets();
    const cases: [Record<string, unknown>, number, string][] = [
      [{ channel: "no-such-place", body: "x" }, 404, "no_such_channel"],
      [{ channel: "introductions", body: "x" }, 403, "channel_archived"],
      [{ reply_to: 999_999, body: "x" }, 404, "no_such_post"],
      [
        { reply_to: top.body.post.id, channel: "small-talk", body: "x" },
        400,
        "invalid",
      ],
    ];
    for (const [body, status, code] of cases) {
      const res = await write(b.key, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(await buckets()).toEqual(before);
    }
    expect(await posts()).toBe(2);
  });

  it("still tell a silenced bot first that it's silenced", async () => {
    const a = await register("alice");
    await setSilenced(db(), "alice", 1, "Cooling off.");
    const before = await buckets();
    const res = await write(a.key, { channel: "no-such-place", body: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("silenced");
    expect(await buckets()).toEqual(before);
    expect(await posts()).toBe(0);
  });
});

describe("the other limits still count it", () => {
  it("counts it in the hour, either way round", async () => {
    await awayFromWindowEdge(3600);
    const a = await register("alice");
    const hour = LIMITS.postPerHour.limit;
    const over = new RegExp(`${hour} posts an hour`);
    await used(`post:hour:${await botId("alice")}`, 3600, hour - 1);
    expect((await write(a.key, agenda)).status).toBe(201);
    const before = await buckets();
    refused(await write(a.key, elsewhere), over);
    expect(await buckets()).toEqual(before);

    const b = await register("bob");
    await used(`post:hour:${await botId("bob")}`, 3600, hour - 1);
    expect((await write(b.key, elsewhere)).status).toBe(201);
    refused(await write(b.key, agenda), over);
    expect(await posts()).toBe(2);
  });

  it("counts it in the day", async () => {
    await awayFromWindowEdge(86_400);
    const a = await register("alice");
    await establish("alice");
    await used(`post:day:${await botId("alice")}`, 86_400, 199);
    expect((await write(a.key, agenda)).status).toBe(201);
    refused(await write(a.key, elsewhere), /200 posts a day/);
    expect(await posts()).toBe(1);
  });

  it("counts it in a new bot's day", async () => {
    await awayFromWindowEdge(86_400);
    const a = await register("alice");
    const id = await botId("alice");
    await used(`post:new:${id}`, 86_400, LIMITS.postNewPerDay.limit - 1);
    expect((await write(a.key, agenda)).status).toBe(201);
    expect((await buckets())[`post:new:${id}`]).toBe(
      LIMITS.postNewPerDay.limit,
    );
    refused(await write(a.key, elsewhere), /while your bot is new/);
    expect(await posts()).toBe(1);
  });

  it("counts it against the site-wide cap, and is refused at it", async () => {
    await awayFromWindowEdge(3600);
    const a = await register("alice");
    expect((await write(a.key, agenda)).status).toBe(201);
    expect((await buckets())["post:all"]).toBe(1);
    await used("post:all", 3600, ANTI_ABUSE_DEFAULTS.post_global);
    const b = await register("bob");
    const res = await write(b.key, agenda);
    refused(res, /whole site this hour/);
    expect(res.body.error.message).not.toContain(
      String(ANTI_ABUSE_DEFAULTS.post_global),
    );
    expect(await posts()).toBe(1);
    expect((await buckets())["post:all"]).toBe(ANTI_ABUSE_DEFAULTS.post_global);
  });
});

describe("only the site's own #prompted", () => {
  it("gives a thread in any other channel the usual minute", async () => {
    const a = await register("alice");
    expect((await write(a.key, { ...elsewhere, channel: "meta" })).status).toBe(
      201,
    );
    refused(await write(a.key, elsewhere), /1 post a minute/);
  });

  it("gives a bot-made channel with its slug nothing", async () => {
    // The site refuses a bot-made channel named like its own, so this one is
    // put straight into the tables, with the site's own moved aside.
    const a = await register("alice");
    const id = await botId("alice");
    await db()`UPDATE channels SET slug = 'prompted-site' WHERE slug = 'prompted' AND bot_id IS NULL`;
    await db()`
      INSERT INTO channels (slug, name, description, bot_id)
      VALUES ('prompted', 'Prompted', 'Not the site''s own.', ${id})`;
    expect((await write(a.key, agenda)).status).toBe(201);
    refused(await write(a.key, elsewhere), /1 post a minute/);
    expect(await posts()).toBe(1);
  });
});

describe("through the connector", () => {
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
        params: { name: "post", arguments: args },
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

  it("lets an agenda and the post after it through in one visit", async () => {
    const a = await register("alice");
    const first = await tool(a.key, { ...agenda, title: "My agenda" });
    expect(first.isError).toBe(false);
    const second = await tool(a.key, {
      ...elsewhere,
      title: "What I came for",
    });
    expect(second.isError).toBe(false);
    const third = await tool(a.key, { ...elsewhere, title: "One more" });
    expect(third.isError).toBe(true);
    expect(third.body.error.code).toBe("rate_limited");
    expect(await posts()).toBe(2);
  });
});
