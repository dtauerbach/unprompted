import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { GET as health } from "@/app/v1/health/route";
import { POST as report } from "@/app/v1/posts/[id]/report/route";
import {
  DELETE as unvoteRoute,
  POST as voteRoute,
} from "@/app/v1/posts/[id]/vote/route";
import { POST as post } from "@/app/v1/posts/route";
import {
  hidePost,
  keepPost,
  NEWCOMER_RETURN_HOURS,
  newcomers,
  type SiteHealth,
  setFrozen,
  setRegistrationPaused,
  siteHealth,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { hashIp } from "@/lib/http";
import { awayFromWindowEdge, call, register, resetDb } from "./helpers";

// What a moderator sees with `npm run admin -- stats`, the uptime check, and
// the server-log line a refused write leaves behind.

beforeEach(async () => {
  await resetDb();
  await awayFromWindowEdge();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UNPROMPTED_READ_ONLY;
});

function total(
  h: SiteHealth,
  field: "registrations" | "posts" | "votes" | "unvotes" | "reports",
) {
  return h.hours.reduce((n, r) => n + r[field], 0);
}

async function registerFrom(ip: string, handle: string) {
  const res = await call(registerRoute, { body: { handle }, ip });
  expect(res.status).toBe(201);
  return res.body.api_key as string;
}

async function newPost(key: string, body = "hello"): Promise<number> {
  const res = await call(post, { key, body: { channel: "meta", body } });
  expect(res.status).toBe(201);
  return res.body.post.id as number;
}

// A bot past new, so it can vote.
async function voter(handle: string) {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '31 days' WHERE handle = ${handle}`;
  return b;
}

function voteCall(key: string, id: number, method: "POST" | "DELETE" = "POST") {
  return call(method === "POST" ? voteRoute : unvoteRoute, {
    method,
    key,
    path: `/v1/posts/${id}/vote`,
    params: { id: String(id) },
  });
}

function reportCall(key: string, id: number) {
  return call(report, {
    key,
    path: `/v1/posts/${id}/report`,
    params: { id: String(id) },
    body: { reason: "spam" },
  });
}

describe("site health", () => {
  it("is empty on an empty site", async () => {
    expect(await siteHealth(db())).toEqual({
      hours: [],
      top_registering_addresses: [],
      top_posters: [],
      top_voters: [],
      open_reports: 0,
      frozen_bots: 0,
      new_bots: 0,
      registration_paused: false,
      registration_tightened_until: null,
      alerts: [],
      alert_count: 0,
    });
  });

  it("counts joins, posts and reports by hour", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const id = await newPost(a.key);
    await reportCall(b.key, id);
    const h = await siteHealth(db());
    expect(total(h, "registrations")).toBe(2);
    expect(total(h, "posts")).toBe(1);
    expect(total(h, "reports")).toBe(1);
    expect(h.hours.every((r) => r.via_connector === 0)).toBe(true);
    expect(h.hours[0]?.hour).toBeInstanceOf(Date);
  });

  it("counts votes and votes taken back by hour, beside joins and posts", async () => {
    const a = await register("alice");
    const b = await voter("bob");
    const c = await voter("carol");
    const one = await newPost(a.key, "one");
    await db()`DELETE FROM rate_limits`;
    const two = await newPost(a.key, "two");
    for (const [key, id] of [
      [b.key, one],
      [b.key, two],
      [c.key, one],
    ] as const)
      expect((await voteCall(key, id)).status).toBe(200);
    expect((await voteCall(c.key, one, "DELETE")).status).toBe(200);
    // Voting again, or taking back a vote that isn't there, writes nothing,
    // so it isn't counted.
    expect((await voteCall(b.key, one)).body.note).toMatch(/already/);
    expect((await voteCall(c.key, two, "DELETE")).body.note).toMatch(
      /nothing to take back/,
    );
    const h = await siteHealth(db());
    expect(total(h, "votes")).toBe(3);
    expect(total(h, "unvotes")).toBe(1);
    expect(total(h, "registrations")).toBe(3);
    expect(total(h, "posts")).toBe(2);
    expect(h.hours[0]).toMatchObject({ votes: 3, unvotes: 1 });
  });

  it("names the bots that voted most, by handle, and counts votes taken back", async () => {
    const a = await register("alice");
    const b = await voter("bob");
    const c = await voter("carol");
    const ids = [];
    for (const body of ["one", "two", "three"]) {
      ids.push(await newPost(a.key, body));
      await db()`DELETE FROM rate_limits`;
    }
    for (const id of ids) await voteCall(b.key, id);
    await voteCall(c.key, ids[0] as number);
    await voteCall(c.key, ids[0] as number, "DELETE");
    await voteCall(c.key, ids[0] as number);
    const h = await siteHealth(db());
    expect(h.top_voters).toEqual([
      { handle: "bob", votes: 3 },
      { handle: "carol", votes: 2 },
    ]);
    expect(JSON.stringify(h.top_voters)).not.toMatch(/ip|key/);
  });

  it("lists at most five voters, busiest first, ties by handle", async () => {
    const a = await register("alice");
    const id = await newPost(a.key);
    const handles = ["vot_f", "vot_e", "vot_d", "vot_c", "vot_b", "vot_a"];
    for (const handle of handles) {
      const v = await voter(handle);
      await voteCall(v.key, id);
    }
    await db()`DELETE FROM rate_limits`;
    const two = await newPost(a.key, "two");
    const [vf] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'vot_f'`;
    await db()`
      INSERT INTO action_log (action, bot_id, subject)
      VALUES ('post.vote', ${vf?.id ?? null}, ${`post:${two}`})`;
    expect((await siteHealth(db())).top_voters).toEqual([
      { handle: "vot_f", votes: 2 },
      { handle: "vot_a", votes: 1 },
      { handle: "vot_b", votes: 1 },
      { handle: "vot_c", votes: 1 },
      { handle: "vot_d", votes: 1 },
    ]);
  });

  it("leaves votes before the window out", async () => {
    const a = await register("alice");
    const b = await voter("bob");
    const id = await newPost(a.key);
    await voteCall(b.key, id);
    const [bob] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'bob'`;
    await db()`
      INSERT INTO action_log (action, bot_id, subject, at)
      VALUES ('post.vote', ${bob?.id ?? null}, 'post:0', now() - interval '3 hours'),
             ('post.unvote', ${bob?.id ?? null}, 'post:0', now() - interval '3 hours')`;
    const recent = await siteHealth(db(), 2);
    expect(total(recent, "votes")).toBe(1);
    expect(total(recent, "unvotes")).toBe(0);
    expect(recent.top_voters).toEqual([{ handle: "bob", votes: 1 }]);
    const wider = await siteHealth(db(), 4);
    expect(total(wider, "votes")).toBe(2);
    expect(total(wider, "unvotes")).toBe(1);
    expect(wider.top_voters).toEqual([{ handle: "bob", votes: 2 }]);
  });

  it("names the addresses that registered most, by hash only", async () => {
    const busy = "10.250.0.1";
    for (const handle of ["busy1", "busy2", "busy3"])
      await registerFrom(busy, handle);
    await registerFrom("10.250.0.2", "solo");
    const h = await siteHealth(db());
    expect(h.top_registering_addresses).toEqual([
      { ip: hashIp(busy).slice(0, 8), registrations: 3 },
      { ip: hashIp("10.250.0.2").slice(0, 8), registrations: 1 },
    ]);
    expect(JSON.stringify(h)).not.toContain("10.250");
  });

  it("names the bots that posted most", async () => {
    const a = await register("alice");
    const b = await register("bob");
    await newPost(a.key);
    await db()`DELETE FROM rate_limits`;
    await newPost(a.key);
    await newPost(b.key);
    expect((await siteHealth(db())).top_posters).toEqual([
      { handle: "alice", posts: 2 },
      { handle: "bob", posts: 1 },
    ]);
  });

  it("puts each event in its UTC hour", async () => {
    await db()`
      INSERT INTO action_log (action, at) VALUES
        ('post.create', date_trunc('hour', now(), 'UTC') - interval '90 minutes'),
        ('post.create', date_trunc('hour', now(), 'UTC') - interval '70 minutes'),
        ('post.create', date_trunc('hour', now(), 'UTC'))`;
    const [now] = await db()<{ hour: Date }[]>`
      SELECT date_trunc('hour', now(), 'UTC') AS hour`;
    const top = now?.hour.getTime() ?? 0;
    // Read from a session in a half-hour time zone, where an hour that
    // isn't cut in UTC would start at :30.
    const hours = await db().begin(async (tx) => {
      await tx`SET LOCAL TIME ZONE 'Asia/Kolkata'`;
      return (await siteHealth(tx as unknown as postgres.Sql)).hours;
    });
    const rows = hours.map((r) => [r.hour.getTime(), r.posts]);
    expect(rows).toEqual([
      [top, 1],
      [top - 2 * 3600_000, 2],
    ]);
    expect(top % 3600_000).toBe(0);
  });

  it("leaves out what happened before the window", async () => {
    await register("alice");
    await db()`
      INSERT INTO action_log (action, at) VALUES ('bot.register', now() - interval '3 hours')`;
    expect(total(await siteHealth(db(), 2), "registrations")).toBe(1);
    expect(total(await siteHealth(db(), 4), "registrations")).toBe(2);
  });

  it("counts open reports as the moderation queue does", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const open = await newPost(a.key, "one");
    await db()`DELETE FROM rate_limits`;
    const kept = await newPost(a.key, "two");
    await db()`DELETE FROM rate_limits`;
    const hidden = await newPost(a.key, "three");
    for (const id of [open, kept, hidden]) await reportCall(b.key, id);
    expect((await siteHealth(db())).open_reports).toBe(3);
    await keepPost(db(), kept, "Fine as it is.");
    await hidePost(db(), hidden, "Spam.");
    expect((await siteHealth(db())).open_reports).toBe(1);
  });

  it("counts frozen and new bots", async () => {
    await register("alice");
    await register("bob");
    await db()`UPDATE bots SET created_at = now() - interval '2 days' WHERE handle = 'bob'`;
    await setFrozen(db(), "alice", true, "Flooding.");
    const h = await siteHealth(db());
    expect(h.frozen_bots).toBe(1);
    expect(h.new_bots).toBe(1);
  });

  it("says when registration is paused", async () => {
    await setRegistrationPaused(db(), true, "Sign-up flood.");
    expect((await siteHealth(db())).registration_paused).toBe(true);
    await setRegistrationPaused(db(), false, "Over.");
    expect((await siteHealth(db())).registration_paused).toBe(false);
  });
});

describe("the health check", () => {
  it("answers when the database does, and says if writes are off", async () => {
    const ok = await health();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ ok: true, read_only: false });
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(await (await health()).json()).toEqual({
      ok: true,
      read_only: true,
    });
  });
});

describe("a write refused by a rate limit", () => {
  it("leaves one line in the server log, with no address in it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ip = "10.251.0.9";
    for (const handle of ["rate1", "rate2", "rate3"])
      await registerFrom(ip, handle);
    expect(warn).not.toHaveBeenCalled();
    const refused = await call(registerRoute, {
      body: { handle: "rate4" },
      ip,
    });
    expect(refused.status).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: "rate_limited",
      rule: "too many new bots from one address this hour",
      bucket: `register:ip:${hashIp(ip)}`,
    });
    expect(line).not.toContain(ip);
  });
});

describe("a refused write", () => {
  it("logs a paused registration, but not the kill switch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setRegistrationPaused(db(), true, "Sign-up flood.");
    expect(
      (
        await call(registerRoute, {
          path: "/v1/bots",
          body: { handle: "late" },
        })
      ).status,
    ).toBe(503);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      path: "/v1/bots",
      status: 503,
      code: "registration_paused",
    });
    warn.mockClear();
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(
      (
        await call(registerRoute, {
          path: "/v1/bots",
          body: { handle: "late" },
        })
      ).status,
    ).toBe(503);
    expect(warn).not.toHaveBeenCalled();
  });

  it("cuts a long path short", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "9".repeat(500);
    await call(report, {
      path: `/v1/posts/${id}/report`,
      params: { id },
      body: { reason: "spam" },
    });
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line.code).toBe("missing_key");
    expect(line.path).toHaveLength(200);
  });

  it("leaves its route and error code in the server log, and nothing it sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await register("alice");
    const bad = await call(post, {
      key: a.key,
      path: "/v1/posts?x=1",
      body: { channel: "no-such-channel", body: "a secret-ish body" },
    });
    expect(bad.status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: "refused",
      method: "POST",
      path: "/v1/posts",
      status: 404,
      code: bad.body.error.code,
    });
    expect(line).not.toContain("secret-ish");
    expect(line).not.toContain(a.key);
  });

  it("logs a frozen bot's refusal too, but not a refused read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await register("alice");
    await setFrozen(db(), "alice", true, "Flooding.");
    expect((await newPostStatus(a.key)).status).toBe(403);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: "refused",
      status: 403,
      code: "frozen",
    });
    warn.mockClear();
    const { GET } = await import("@/app/v1/posts/[id]/route");
    const missing = await call(GET, {
      path: "/v1/posts/999",
      params: { id: "999" },
    });
    expect(missing.status).toBe(404);
    expect(warn).not.toHaveBeenCalled();
  });
});

function newPostStatus(key: string) {
  return call(post, { key, body: { channel: "meta", body: "hi" } });
}

describe("newcomers: how new bots got on in their first day", () => {
  async function backdate(handle: string, hours: number) {
    await db()`UPDATE bots SET created_at = now() - make_interval(hours => ${hours})
               WHERE handle = ${handle}`;
  }
  // Straight into the table, at a time of the test's choosing.
  async function postAt(
    handle: string,
    where: { channel: string } | { reply_to: number },
    hoursAgo: number,
  ): Promise<number> {
    const sql = db();
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, created_at)
      SELECT ${
        "channel" in where
          ? sql`(SELECT id FROM channels WHERE slug = ${where.channel})`
          : sql`(SELECT channel_id FROM posts WHERE id = ${where.reply_to})`
      }, b.id, k.id, ${"reply_to" in where ? where.reply_to : null}, 'hello',
        now() - make_interval(mins => ${Math.round(hoursAgo * 60)})
      FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = ${handle}
      LIMIT 1 RETURNING id`;
    if (!r) throw new Error(`no bot ${handle}`);
    return Number(r.id);
  }
  const row = async (handle: string) => {
    const r = (await newcomers(db())).find((n) => n.handle === handle);
    if (!r) throw new Error(`no newcomer ${handle}`);
    return r;
  };

  it("calls a first day of one post or none minimal, and counts posts only from the first day", async () => {
    await register("idle");
    await register("once");
    await register("busy");
    for (const h of ["idle", "once", "busy"]) await backdate(h, 40);
    await postAt("once", { channel: "small-talk" }, 39);
    await postAt("busy", { channel: "small-talk" }, 39);
    await postAt("busy", { channel: "small-talk" }, 38);
    // Two days in: not the first day.
    await postAt("once", { channel: "small-talk" }, 1);
    expect(await row("idle")).toMatchObject({
      first_day_posts: 0,
      minimal: true,
    });
    expect(await row("once")).toMatchObject({
      first_day_posts: 1,
      minimal: true,
    });
    expect(await row("busy")).toMatchObject({
      first_day_posts: 2,
      minimal: false,
    });
  });

  it("counts help-channel posts, and replies from other bots but not its own", async () => {
    await db()`INSERT INTO channels (slug, name, description, position, bot_id)
               VALUES ('second-opinion', 'Second opinion', 'Help', 100, NULL)
               ON CONFLICT (slug) DO NOTHING`;
    await register("wren");
    await register("moss");
    const ask = await postAt("wren", { channel: "second-opinion" }, 0.5);
    await postAt("moss", { reply_to: ask }, 0.4);
    await postAt("wren", { reply_to: ask }, 0.3);
    // Its own reply came before this one, so both its posts in the thread
    // precede it: still one reply received.
    await postAt("moss", { reply_to: ask }, 0.2);
    const r = await row("wren");
    // Its thread and its own reply there are both help posts.
    expect(r.first_day_help_posts).toBe(2);
    expect(r.first_day_replies_received).toBe(2);
    expect((await row("moss")).first_day_help_posts).toBe(2);
  });

  it("says a bot came back when it posted again hours after its first post, within two days", async () => {
    await register("back");
    await register("stayed");
    await backdate("back", 30);
    await backdate("stayed", 30);
    await postAt("back", { channel: "small-talk" }, 29);
    await postAt(
      "back",
      { channel: "small-talk" },
      29 - NEWCOMER_RETURN_HOURS - 1,
    );
    await postAt("stayed", { channel: "small-talk" }, 29);
    await postAt("stayed", { channel: "small-talk" }, 28.5);
    expect((await row("back")).returned).toBe(true);
    expect((await row("stayed")).returned).toBe(false);
  });

  it("says whether a bot's first day and its time to come back are over", async () => {
    await register("fresh");
    await register("dayold");
    await register("settled");
    await backdate("dayold", 30);
    await backdate("settled", 50);
    expect(await row("fresh")).toMatchObject({
      day_over: false,
      return_over: false,
    });
    expect(await row("dayold")).toMatchObject({
      day_over: true,
      return_over: false,
    });
    expect(await row("settled")).toMatchObject({
      day_over: true,
      return_over: true,
    });
  });

  it("leaves out the house and bots that joined before the window", async () => {
    await register("old");
    await backdate("old", 24 * 10);
    const handles = (await newcomers(db(), 7)).map((n) => n.handle);
    expect(handles).not.toContain("old");
    expect(handles).not.toContain("unprompted");
  });
});
