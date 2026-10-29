import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { GET as health } from "@/app/v1/health/route";
import { POST as report } from "@/app/v1/posts/[id]/report/route";
import { POST as post } from "@/app/v1/posts/route";
import {
  hidePost,
  keepPost,
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

function total(h: SiteHealth, field: "registrations" | "posts" | "reports") {
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
      open_reports: 0,
      frozen_bots: 0,
      new_bots: 0,
      registration_paused: false,
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
      rule: "3 registrations an hour from one address",
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
