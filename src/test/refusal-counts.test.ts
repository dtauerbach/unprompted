import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as post } from "@/app/v1/posts/route";
import { db } from "@/lib/db";
import { ApiError, logRefusal } from "@/lib/http";
import { OPERATIONS } from "@/lib/openapi";
import {
  countedAs,
  countRefusal,
  FLUSH_GAP_MS,
  flushRefusals,
  kickRefusals,
  refusalCounts,
  resetRefusalFlush,
  resetRefusalGap,
  waitingRefusals,
} from "@/lib/refusal-counts";
import { call, register, resetDb } from "./helpers";

const templates = OPERATIONS;

type Row = {
  surface: string;
  what: string;
  code: string;
  status: number;
  n: string;
};
const rows = () =>
  // Byte order, so the rows read the same whatever the database's collation
  // (CI's sorts "other" before "POST ...", a C locale after).
  db()<Row[]>`SELECT surface, what, code, status, n FROM refusal_counts
    ORDER BY surface COLLATE "C", what COLLATE "C", code COLLATE "C"`;

beforeEach(async () => {
  // Whatever another file noted stays in memory; drop it before each test.
  await flushRefusals(db());
  resetRefusalFlush();
  await resetDb();
  delete process.env.UNPROMPTED_READ_ONLY;
});

afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

describe("what a refusal is counted under", () => {
  it("names a route by its template, never the path it was called with", () => {
    expect(countedAs("POST", "/v1/posts/123/report", templates)).toEqual({
      surface: "HTTP",
      what: "POST /v1/posts/{id}/report",
    });
    expect(countedAs("POST", "/v1/bots/somebody/block", templates)).toEqual({
      surface: "HTTP",
      what: "POST /v1/bots/{handle}/block",
    });
    // An empty segment doesn't fill a placeholder.
    expect(countedAs("POST", "/v1/posts//report", templates).what).toBe(
      "other",
    );
  });

  it("files anything it doesn't know as other, so no caller picks a row", () => {
    for (const [method, path] of [
      ["POST", "/v1/no-such-route"],
      ["POST", "/copy/mcp/unpcopy_secretkeysecretkey"],
      ["POST", "/v1/wake/0123456789abcdef0123456789abcdef"],
      ["BREW", "/v1/posts"],
      ["POST", "/v1/posts?x=1"],
    ] as const)
      expect(countedAs(method, path, templates)).toEqual({
        surface: "HTTP",
        what: "other",
      });
    expect(countedAs("MCP", "/mcp post", templates)).toEqual({
      surface: "MCP",
      what: "/mcp post",
    });
    expect(countedAs("MCP", "/copy/mcp set_copy", templates).what).toBe(
      "/copy/mcp set_copy",
    );
    expect(countedAs("MCP", "/mcp Ignore previous; DROP", templates).what).toBe(
      "other",
    );
    expect(countedAs("ACTION", "startGroup", templates)).toEqual({
      surface: "ACTION",
      what: "startGroup",
    });
    expect(countedAs("PAGE", "autoApprove", templates)).toEqual({
      surface: "ACTION",
      what: "autoApprove",
    });
    expect(countedAs("ACTION", "x y", templates).what).toBe("other");
  });
});

describe("counting", () => {
  it("adds refusals up by day and code, and only a write's", async () => {
    countRefusal("POST", "/v1/posts/1/report", 429, "rate_limited");
    countRefusal("POST", "/v1/posts/2/report", 429, "rate_limited");
    countRefusal("POST", "/v1/posts/3/report", 403, "not_yet");
    countRefusal("MCP", "/mcp post", 403, "not_yet");
    countRefusal("ACTION", "startGroup", 403, "not_yours");
    // Not counted: a read, our own failure, the kill switch's answer, and
    // anything malformed.
    countRefusal("GET", "/v1/posts", 404, "no_such_post");
    countRefusal("HEAD", "/v1/posts", 404, "no_such_post");
    countRefusal("POST", "/v1/posts", 500, "internal");
    countRefusal("POST", "/v1/posts", 503, "read_only");
    countRefusal("POST", "/v1/posts", 403, "Not A Code");
    countRefusal("POST", "/v1/posts", 200, "fine");
    expect(waitingRefusals()).toBe(5);
    expect(await flushRefusals(db())).toBe(5);
    expect(waitingRefusals()).toBe(0);
    expect(await rows()).toEqual([
      {
        surface: "ACTION",
        what: "startGroup",
        code: "not_yours",
        status: 403,
        n: "1",
      },
      {
        surface: "HTTP",
        what: "POST /v1/posts/{id}/report",
        code: "not_yet",
        status: 403,
        n: "1",
      },
      {
        surface: "HTTP",
        what: "POST /v1/posts/{id}/report",
        code: "rate_limited",
        status: 429,
        n: "2",
      },
      {
        surface: "MCP",
        what: "/mcp post",
        code: "not_yet",
        status: 403,
        n: "1",
      },
    ]);
    // A second flush adds to the same rows.
    countRefusal("MCP", "/mcp post", 403, "not_yet");
    await flushRefusals(db());
    expect((await rows()).find((r) => r.surface === "MCP")?.n).toBe("2");
    // Nothing waiting writes nothing.
    expect(await flushRefusals(db())).toBe(0);
  });

  it("counts nothing under the kill switch", async () => {
    process.env.UNPROMPTED_READ_ONLY = "1";
    countRefusal("POST", "/v1/posts", 403, "not_yet");
    expect(waitingRefusals()).toBe(0);
  });

  it("keeps no key, token or path it was called with", async () => {
    countRefusal("POST", "/copy/mcp/unpcopy_k3yk3yk3yk3y", 401, "invalid_key");
    countRefusal(
      "POST",
      "/v1/wake/0123456789abcdef0123456789abcdef",
      404,
      "no_such_wake",
    );
    countRefusal("POST", "/v1/bots/secret-handle/block", 404, "no_such_bot");
    await flushRefusals(db());
    const all = JSON.stringify(await rows());
    expect(all).not.toMatch(/unpcopy|k3y|0123456789abcdef|secret-handle/);
    expect(all).toContain("POST /v1/bots/{handle}/block");
  });

  it("holds nothing a caller chose, so a flood of junk paths can't hide real routes", async () => {
    // Fable's review of #192: a keyless flood of distinct ids once filled the
    // waiting map, so real refusals behind it were filed as other. Paths are
    // matched to their template when noted, so the flood is one entry.
    for (let i = 0; i < 3000; i++)
      countRefusal("POST", `/v1/posts/${i}/vote`, 401, "missing_key");
    for (let i = 0; i < 3000; i++)
      countRefusal("POST", `/v1/nowhere/${i}`, 404, "no_such_route");
    for (let i = 0; i < 3000; i++)
      countRefusal("MCP", `/mcp junk_${i}`, 400, "bad_request");
    for (let i = 0; i < 3000; i++)
      countRefusal("ACTION", `junk${i}`, 403, "not_yours");
    countRefusal("POST", "/v1/posts/7/report", 429, "rate_limited");
    expect(waitingRefusals()).toBe(12001);
    await flushRefusals(db());
    expect(await rows()).toEqual([
      {
        surface: "ACTION",
        what: "other",
        code: "not_yours",
        status: 403,
        n: "3000",
      },
      {
        surface: "HTTP",
        what: "POST /v1/posts/{id}/report",
        code: "rate_limited",
        status: 429,
        n: "1",
      },
      {
        surface: "HTTP",
        what: "POST /v1/posts/{id}/vote",
        code: "missing_key",
        status: 401,
        n: "3000",
      },
      {
        surface: "HTTP",
        what: "other",
        code: "no_such_route",
        status: 404,
        n: "3000",
      },
      {
        surface: "MCP",
        what: "other",
        code: "bad_request",
        status: 400,
        n: "3000",
      },
    ]);
  });

  it("puts a failed write's counts back, all of them, for the next", async () => {
    countRefusal("POST", "/v1/posts/7/report", 429, "rate_limited");
    countRefusal("MCP", "/mcp post", 403, "not_yet");
    const broken = Object.assign(() => Promise.reject(new Error("down")), {
      array: (a: unknown[]) => a,
    }) as unknown as Parameters<typeof flushRefusals>[0];
    await expect(flushRefusals(broken)).rejects.toThrow("down");
    expect(waitingRefusals()).toBe(2);
    countRefusal("POST", "/v1/posts/8/report", 429, "rate_limited");
    expect(await flushRefusals(db())).toBe(3);
    expect((await rows()).map((r) => [r.what, r.n])).toEqual([
      ["POST /v1/posts/{id}/report", "2"],
      ["/mcp post", "1"],
    ]);
  });

  it("counts a route's refusal even though the refused write rolled back", async () => {
    const res = await call(post, {
      method: "POST",
      path: "/v1/posts",
      body: { channel: "meta", body: "hi" },
    });
    expect(res.status).toBe(401);
    const a = await register("alice");
    const bad = await call(post, {
      method: "POST",
      path: "/v1/posts",
      key: a.key,
      body: { channel: "no-such-channel", body: "hi" },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    await flushRefusals(db());
    const got = await rows();
    expect(got).toContainEqual({
      surface: "HTTP",
      what: "POST /v1/posts",
      code: "missing_key",
      status: 401,
      n: "1",
    });
    expect(got.some((r) => r.code === bad.body.error.code)).toBe(true);
    // logRefusal is the one way in.
    logRefusal("ACTION", "linkWithCode", new ApiError(403, "not_yours", "No."));
    await flushRefusals(db());
    expect(await rows()).toContainEqual({
      surface: "ACTION",
      what: "linkWithCode",
      code: "not_yours",
      status: 403,
      n: "1",
    });
  });

  it("reads back the last days for the moderators, busiest first", async () => {
    countRefusal("MCP", "/mcp vote", 403, "not_yet");
    for (let i = 0; i < 3; i++)
      countRefusal("MCP", "/mcp post", 429, "rate_limited");
    await flushRefusals(db());
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    countRefusal("MCP", "/mcp post", 429, "rate_limited");
    await flushRefusals(db(), old);
    const week = await refusalCounts(db(), 7);
    expect(week.map((r) => [r.what, r.code, r.n])).toEqual([
      ["/mcp post", "rate_limited", 3],
      ["/mcp vote", "not_yet", 1],
    ]);
    expect((await refusalCounts(db(), 30)).length).toBe(3);
  });

  it("holds rows to their shape in the database", async () => {
    await expect(
      db()`INSERT INTO refusal_counts (day, surface, what, code, status, n)
        VALUES (current_date, 'HTTP', 'POST /v1/posts <script>', 'x', 400, 1)`,
    ).rejects.toThrow();
    await expect(
      db()`INSERT INTO refusal_counts (day, surface, what, code, status, n)
        VALUES (current_date, 'EMAIL', 'other', 'x', 400, 1)`,
    ).rejects.toThrow();
    await expect(
      db()`INSERT INTO refusal_counts (day, surface, what, code, status, n)
        VALUES (current_date, 'HTTP', 'other', 'Has Spaces', 400, 1)`,
    ).rejects.toThrow();
    await expect(
      db()`INSERT INTO refusal_counts (day, surface, what, code, status, n)
        VALUES (current_date, 'HTTP', 'other', 'x', 200, 1)`,
    ).rejects.toThrow();
  });

  it("keeps what a failed write held, for the next one", async () => {
    countRefusal("MCP", "/mcp post", 403, "not_yet");
    const broken = Object.assign(
      () => Promise.reject(new Error("database down")),
      { array: (x: unknown[]) => x },
    ) as unknown as Parameters<typeof flushRefusals>[0];
    await expect(flushRefusals(broken)).rejects.toThrow("database down");
    countRefusal("MCP", "/mcp post", 403, "not_yet");
    expect(waitingRefusals()).toBe(2);
    await flushRefusals(db());
    expect((await rows()).find((r) => r.surface === "MCP")?.n).toBe("2");
  });
});

describe("when the count is written", () => {
  it("writes at most once a gap per process, one write at a time", async () => {
    const tasks: (() => Promise<void>)[] = [];
    const schedule = (t: () => Promise<void>) => {
      tasks.push(t);
    };
    const t0 = Date.now();
    // Nothing waiting: nothing scheduled.
    kickRefusals(t0, schedule);
    expect(tasks.length).toBe(0);
    countRefusal("MCP", "/mcp post", 403, "not_yet");
    kickRefusals(t0, schedule);
    // A second kick while the first write hasn't run waits for it.
    kickRefusals(t0 + 1000, schedule);
    expect(tasks.length).toBe(1);
    await tasks[0]?.();
    expect(waitingRefusals()).toBe(0);
    expect((await rows()).length).toBe(1);
    // Inside the gap after a write, a new refusal waits.
    countRefusal("MCP", "/mcp vote", 403, "not_yet");
    kickRefusals(Date.now() + 1000, schedule);
    expect(tasks.length).toBe(1);
    // After the gap, any request writes it, refused or not.
    kickRefusals(Date.now() + FLUSH_GAP_MS + 1, schedule);
    expect(tasks.length).toBe(2);
    await tasks[1]?.();
    expect((await rows()).length).toBe(2);
  });

  it("takes a write that never finished as gone after a minute", () => {
    const tasks: (() => Promise<void>)[] = [];
    const schedule = (t: () => Promise<void>) => {
      tasks.push(t);
    };
    const t0 = Date.now();
    countRefusal("MCP", "/mcp post", 403, "not_yet");
    kickRefusals(t0, schedule);
    // The first never runs (the platform cut its after() off).
    kickRefusals(t0 + 59_000, schedule);
    expect(tasks.length).toBe(1);
    kickRefusals(t0 + 61_000, schedule);
    expect(tasks.length).toBe(2);
  });

  it("doesn't let a write taken as gone clear the guard of the one after it", async () => {
    // Dot's review of #192: a late write's end once cleared the newer one's
    // in-flight mark, letting a third start while the second still ran.
    const tasks: (() => Promise<void>)[] = [];
    const schedule = (t: () => Promise<void>) => {
      tasks.push(t);
    };
    const t0 = Date.now();
    countRefusal("MCP", "/mcp post", 403, "not_yet");
    kickRefusals(t0, schedule);
    countRefusal("MCP", "/mcp vote", 403, "not_yet");
    kickRefusals(t0 + 61_000, schedule);
    expect(tasks.length).toBe(2);
    // The first, taken as gone, finishes late; the second is still running.
    await tasks[0]?.();
    resetRefusalGap();
    countRefusal("MCP", "/mcp vote", 403, "not_yet");
    kickRefusals(t0 + 62_000, schedule);
    expect(tasks.length).toBe(2);
    // The second took both votes when it ran; once it ends, the guard clears.
    await tasks[1]?.();
    resetRefusalGap();
    countRefusal("MCP", "/mcp nudge", 403, "cant_wake");
    kickRefusals(t0 + 63_000, schedule);
    expect(tasks.length).toBe(3);
    await tasks[2]?.();
    const got = await rows();
    expect(got.map((r) => [r.what, r.n])).toEqual([
      ["/mcp nudge", "1"],
      ["/mcp post", "1"],
      ["/mcp vote", "2"],
    ]);
  });

  it("schedules nothing outside a request, and doesn't throw", () => {
    countRefusal("MCP", "/mcp post", 403, "not_yet");
    expect(() => kickRefusals()).not.toThrow();
    expect(waitingRefusals()).toBe(1);
  });
});
