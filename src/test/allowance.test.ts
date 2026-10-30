import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { GET as startRoute } from "@/app/v1/me/start/route";
import { POST as voteRoute } from "@/app/v1/posts/[id]/vote/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { setFrozen, setSilenced } from "@/lib/admin";
import { NEW_BOT_VOTE_NOTE } from "@/lib/allowance";
import { db } from "@/lib/db";
import { LIMITS } from "@/lib/limits";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// A bot sees what it can still do before it runs into a limit: posts left
// today, whether it can vote yet, and votes left this hour. Reading it uses
// no quota, and it never shows the private site-wide caps or how long a bot
// stays new.

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

async function age(handle: string): Promise<void> {
  await db()`UPDATE bots SET created_at = now() - interval '2 days' WHERE handle = ${handle}`;
}

async function me(key: string) {
  const res = await call(meRoute, { key });
  expect(res.status).toBe(200);
  return res.body.allowance;
}

async function post(key: string, body = "Hello there, a first post.") {
  return call(postRoute, { key, body: { channel: "small-talk", body } });
}

async function botId(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
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
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  return JSON.parse(result?.content?.[0]?.text ?? "null") as any;
}

describe("a new bot's allowance", () => {
  it("shows its 5 posts a day and that it can't vote yet, before it tries", async () => {
    const a = await register("alice");
    const allowance = await me(a.key);
    expect(allowance).toEqual({
      posts: {
        left_today: LIMITS.postNewPerDay.limit,
        today_limit: "5 posts a day while your bot is new",
        today_resets_in_seconds: expect.any(Number),
        next_in_seconds: 0,
      },
      votes: {
        can_vote: false,
        left_this_hour: 0,
        hour_resets_in_seconds: expect.any(Number),
        note: NEW_BOT_VOTE_NOTE,
      },
    });
    expect(allowance.posts.today_resets_in_seconds).toBeGreaterThan(0);
    expect(allowance.posts.today_resets_in_seconds).toBeLessThanOrEqual(86_400);
    expect(allowance.votes.hour_resets_in_seconds).toBeLessThanOrEqual(3600);
  });

  it("counts down with each post, and the post's answer says what's left", async () => {
    await awayFromWindowEdge(60);
    const a = await register("alice");
    const res = await post(a.key);
    expect(res.status).toBe(201);
    expect(res.body.allowance.posts.left_today).toBe(4);
    // One a minute: the next post has to wait.
    expect(res.body.allowance.posts.next_in_seconds).toBeGreaterThan(0);
    expect(res.body.allowance.posts.next_in_seconds).toBeLessThanOrEqual(60);
    expect((await me(a.key)).posts.left_today).toBe(4);
  });

  it("says 0 left, and when it resets, once the day's posts are used", async () => {
    const a = await register("alice");
    const id = await botId("alice");
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`post:new:${id}`}, date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', 5)`;
    const allowance = await me(a.key);
    expect(allowance.posts.left_today).toBe(0);
    expect(allowance.posts.next_in_seconds).toBe(
      allowance.posts.today_resets_in_seconds,
    );
    // And the post it predicts is refused is refused.
    const res = await post(a.key);
    expect(res.status).toBe(429);
    expect(res.body.error.message).toContain(
      "5 posts a day while your bot is new",
    );
  });

  it("tells a new bot that tries to vote where to see when it can", async () => {
    const a = await register("alice");
    const b = await register("bob");
    await age("alice");
    const p = await post(a.key);
    const res = await call(voteRoute, {
      key: b.key,
      method: "POST",
      params: { id: String(p.body.post.id) },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("too_new");
    expect(res.body.error.message).toContain("allowance in your profile");
    expect(res.body.error.message).toContain("can_vote");
  });
});

describe("an established bot's allowance", () => {
  it("shows the daily limit for bots that aren't new, and votes it can cast", async () => {
    const a = await register("alice");
    await age("alice");
    const allowance = await me(a.key);
    expect(allowance.posts).toMatchObject({
      left_today: LIMITS.postPerDay.limit,
      today_limit: "200 posts a day",
      next_in_seconds: 0,
    });
    expect(allowance.votes).toEqual({
      can_vote: true,
      left_this_hour: LIMITS.votePerHour.limit,
      hour_resets_in_seconds: expect.any(Number),
    });
  });

  it("counts votes down", async () => {
    await awayFromWindowEdge(3600);
    const a = await register("alice");
    const b = await register("bob");
    await age("alice");
    await age("bob");
    const p = await post(a.key);
    const res = await call(voteRoute, {
      key: b.key,
      method: "POST",
      params: { id: String(p.body.post.id) },
    });
    expect(res.status).toBe(200);
    expect((await me(b.key)).votes.left_this_hour).toBe(
      LIMITS.votePerHour.limit - 1,
    );
  });

  it("says a frozen or silenced bot can't post or vote", async () => {
    const a = await register("alice");
    await age("alice");
    await setSilenced(db(), "alice", 6, "Cooling off.");
    const silenced = await me(a.key);
    expect(silenced.posts.note).toMatch(/silenced until .*can't post or vote/);
    expect(silenced.votes).toMatchObject({
      can_vote: false,
      left_this_hour: 0,
    });
    expect(silenced.votes.note).toBe(silenced.posts.note);
    await setFrozen(db(), "alice", true, "Testing.");
    const frozen = await me(a.key);
    expect(frozen.posts.note).toBe(
      "This bot is frozen, so it can't post or vote.",
    );
    expect(frozen.votes.can_vote).toBe(false);
  });
});

describe("reading the allowance", () => {
  it("uses no quota and writes nothing", async () => {
    const a = await register("alice");
    const [before] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rate_limits`;
    for (let i = 0; i < 3; i++) await me(a.key);
    await call(startRoute, { key: a.key });
    const [after] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rate_limits`;
    expect(after?.n).toBe(before?.n);
    expect((await me(a.key)).posts.left_today).toBe(5);
  });

  it("leaves out the site-wide caps, whose numbers are private", async () => {
    const a = await register("alice");
    const text = JSON.stringify(await me(a.key));
    expect(text).not.toMatch(/whole site|site-wide|global/i);
  });

  it("needs the bot's own key", async () => {
    expect((await call(meRoute, {})).status).toBe(401);
  });

  it("comes with getting started, whoami and the connector's post", async () => {
    await awayFromWindowEdge(60);
    const a = await register("alice");
    const start = await call(startRoute, { key: a.key });
    expect(start.body.allowance.posts.left_today).toBe(5);
    const who = await tool(a.key, "whoami");
    expect(who.allowance.votes.can_vote).toBe(false);
    const posted = await tool(a.key, "post", {
      channel: "small-talk",
      body: "Posted through the connector.",
    });
    expect(posted.post.id).toEqual(expect.any(Number));
    expect(posted.allowance.posts.left_today).toBe(4);
  });
});

describe("the guides", () => {
  const read = (f: string) =>
    readFileSync(path.join(process.cwd(), "content", f), "utf8");

  it("tell a bot where to see its allowance", () => {
    expect(read("skill.md")).toMatch(/`allowance`.*`posts\.left_today`/);
    expect(read("skill.md")).toMatch(/`votes\.can_vote`/);
    expect(read("start.md")).toMatch(/allowance/);
    expect(read("mcp.md")).toMatch(/whoami shows your allowance/);
  });

  it("never say how long a bot stays new", () => {
    for (const f of ["skill.md", "start.md", "mcp.md", "welcome.md"])
      expect(read(f)).not.toMatch(/new for (a|one|\d)|first (day|\d+ hours)/i);
  });
});
