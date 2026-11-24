import { beforeEach, describe, expect, it } from "vitest";
import { POST as eventsRoute } from "@/app/v1/events/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { db } from "@/lib/db";
import {
  EVERY_MINUTES_REFUSAL,
  IN_MINUTES_REFUSAL,
  NOTICE_REFUSAL,
  SESSION_START_REFUSAL,
  TIMES_REFUSAL,
} from "@/lib/validate";
import { call, freshIp, register, resetDb } from "./helpers";

// P5, stated limits (Dot's R433 and R436): a bot that gives a session's
// times or a notice out of bounds reads the bound it can choose within, in
// plain words, whatever was wrong with the value, over HTTP and the
// connector alike. Only the public bounds the guide states; no private cap,
// and no Retry-After, which is for a quota's 429 alone.

beforeEach(resetDb);

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

let rpcId = 0;
async function tool(key: string, name: string, args: object) {
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
  const body = await res.json();
  return {
    isError: Boolean(body.result?.isError || body.error),
    text: String(body.result?.content?.[0]?.text ?? body.error?.message ?? ""),
  };
}

const session = (extra: object) => ({
  action: "session",
  channel: "private:999999",
  in_minutes: 30,
  ...extra,
});

describe("a session's times, refused in plain words", () => {
  const cases: [string, object, string, string][] = [
    [
      "every_minutes too big",
      { every_minutes: 10_081 },
      "every_minutes",
      EVERY_MINUTES_REFUSAL,
    ],
    [
      "every_minutes too small",
      { every_minutes: 14 },
      "every_minutes",
      EVERY_MINUTES_REFUSAL,
    ],
    [
      "every_minutes a fraction",
      { every_minutes: 30.5 },
      "every_minutes",
      EVERY_MINUTES_REFUSAL,
    ],
    [
      "every_minutes a string",
      { every_minutes: "60" },
      "every_minutes",
      EVERY_MINUTES_REFUSAL,
    ],
    ["times over 12", { every_minutes: 60, times: 13 }, "times", TIMES_REFUSAL],
    ["times zero", { every_minutes: 60, times: 0 }, "times", TIMES_REFUSAL],
    [
      "in_minutes past 7 days",
      { in_minutes: 10_081 },
      "in_minutes",
      IN_MINUTES_REFUSAL,
    ],
    [
      "in_minutes a fraction",
      { in_minutes: 6.5 },
      "in_minutes",
      IN_MINUTES_REFUSAL,
    ],
    // Past 2^53, .int() raises a too_big of its own; the line comes once.
    [
      "every_minutes past 2^53",
      { every_minutes: 1e20 },
      "every_minutes",
      EVERY_MINUTES_REFUSAL,
    ],
    [
      "times past 2^53",
      { every_minutes: 60, times: 1e20 },
      "times",
      TIMES_REFUSAL,
    ],
    [
      "in_minutes past 2^53",
      { in_minutes: 1e20 },
      "in_minutes",
      IN_MINUTES_REFUSAL,
    ],
    [
      "every_minutes null",
      { every_minutes: null },
      "every_minutes",
      EVERY_MINUTES_REFUSAL,
    ],
    [
      "times a boolean",
      { every_minutes: 60, times: true },
      "times",
      TIMES_REFUSAL,
    ],
  ];

  it("states the bound itself, with no number the guide doesn't", () => {
    expect(EVERY_MINUTES_REFUSAL).toBe(
      "Choose a whole number from 15 through 10,080 for minutes between meetings.",
    );
    expect(NOTICE_REFUSAL).toBe(
      "Choose 0, 5, 10 or 15 minutes for the notice.",
    );
    expect(TIMES_REFUSAL).toBe(
      "Choose a whole number from 1 through 12 for times. A session ends after 12 times or 7 days, whichever comes first.",
    );
    expect(SESSION_START_REFUSAL).toBe(
      "A session starts 5 minutes to 7 days from now.",
    );
    expect(IN_MINUTES_REFUSAL).toBe(
      "Choose a whole number of minutes for in_minutes: a session starts 5 minutes to 7 days from now.",
    );
  });

  it.each(cases)("over HTTP: %s", async (_, extra, field, line) => {
    const a = await bot("ada-p5");
    const res = await call(eventsRoute, { key: a.key, body: session(extra) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid");
    expect(res.body.error.message).toBe(`${field}: ${line}`);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(res.body.error.retry_after_seconds).toBeUndefined();
  });

  it.each(cases)("on the connector: %s", async (_, extra, __, line) => {
    const a = await bot("bea-p5");
    const got = await tool(a.key, "set_event", session(extra));
    expect(got.isError).toBe(true);
    expect(got.text.split(line).length - 1).toBe(1);
    expect(got.text).not.toContain("retry_after");
  });

  it("a start too soon reads the same line the schema gives", async () => {
    const a = await bot("cal-p5");
    const res = await call(eventsRoute, {
      key: a.key,
      body: session({ in_minutes: 2 }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(SESSION_START_REFUSAL);
  });
});

describe("two fields wrong at once", () => {
  it("names each, once, joined", async () => {
    const a = await bot("fay-p5");
    const res = await call(eventsRoute, {
      key: a.key,
      body: session({ every_minutes: 1, times: 99 }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      `every_minutes: ${EVERY_MINUTES_REFUSAL}; times: ${TIMES_REFUSAL}`,
    );
  });
});

describe("a notice, refused in plain words", () => {
  it("a notice with going: false reads the notice line alone", async () => {
    const a = await bot("gus-p5");
    const res = await call(rsvpRoute, {
      key: a.key,
      params: { id: "999999" },
      body: { going: false, notice_minutes: 7 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(`notice_minutes: ${NOTICE_REFUSAL}`);
  });

  for (const bad of [7, 20, -5, 5.5, "10", null]) {
    it(`notice_minutes ${JSON.stringify(bad)}`, async () => {
      const a = await bot("dee-p5");
      const answer = await call(eventsRoute, {
        key: a.key,
        body: {
          action: "answer",
          channel: "private:999999",
          notice_minutes: bad,
        },
      });
      expect(answer.status).toBe(400);
      expect(answer.body.error.message).toBe(
        `notice_minutes: ${NOTICE_REFUSAL}`,
      );
      expect(answer.headers.get("retry-after")).toBeNull();

      const rsvp = await call(rsvpRoute, {
        key: a.key,
        params: { id: "999999" },
        body: { going: true, notice_minutes: bad },
      });
      expect(rsvp.status).toBe(400);
      expect(rsvp.body.error.message).toBe(`notice_minutes: ${NOTICE_REFUSAL}`);
      expect(rsvp.headers.get("retry-after")).toBeNull();

      for (const [name, args] of [
        [
          "set_event",
          { action: "answer", channel: "private:999999", notice_minutes: bad },
        ],
        ["rsvp", { gathering: 999999, going: true, notice_minutes: bad }],
      ] as const) {
        const got = await tool(a.key, name, args);
        expect(got.isError, name).toBe(true);
        expect(got.text, name).toContain(NOTICE_REFUSAL);
      }
    });
  }

  it("a good value still passes the schema and reaches the channel check", async () => {
    const a = await bot("eve-p5");
    const res = await call(eventsRoute, {
      key: a.key,
      body: { action: "answer", channel: "private:999999", notice_minutes: 10 },
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("no_such_channel");
  });
});
