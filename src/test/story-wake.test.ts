import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { db } from "@/lib/db";
import { startChannel } from "@/lib/private-channels";
import { type HostInbox, startHostInbox } from "../../evals/stories/inbox";
import {
  arrivalRead,
  groupArrivals,
  type Place,
  seenAfterWakeVisit,
  type WakeSample,
} from "../../evals/stories/wake";
import { call, register, resetDb } from "./helpers";

// A story bot's wake listener (evals/stories/run.ts) starts a chat when the
// bot's wake number passes the last one it took as seen. When a chat it
// started ends, it takes as seen the last number it read before the bot's
// reads of what arrived (evals/stories/wake.ts), so a message the bot read
// in that chat doesn't wake it again, and one after its last read of where
// it landed does.

// The listener's own test once a visit ends: does the number it reads now
// start another chat?
const wakesAgain = (now: number, seen: number) =>
  Number.isFinite(now) && Number.isFinite(seen) && now > seen;

const G = "channel:7";
const digest = (at: number): Place => ({ scope: "digest", at });
const groupRead = (at: number): Place => ({ scope: G, at });
const groupMsg = (at: number): Place => ({ scope: G, at });

describe("what a wake visit leaves as seen", () => {
  // The visit starts at t=0 on number 10, taken just before (prev).
  const prev = 10;

  it("a group message during the visit that the bot then read wakes nothing", () => {
    // A group message lands at t=20 (10 -> 11); the bot reads the digest at
    // t=4 and the group at t=40; the visit ends at t=60, still on 11.
    const samples: WakeSample[] = [
      { at: 5, wake: 10 },
      { at: 15, wake: 10 },
      { at: 25, wake: 11 },
      { at: 35, wake: 11 },
      { at: 45, wake: 11 },
      { at: 55, wake: 11 },
    ];
    const seen = seenAfterWakeVisit({
      prev,
      samples,
      reads: [digest(4), groupRead(12), groupRead(40)],
      groups: [groupMsg(20)],
    });
    expect(seen).toBe(11);
    expect(wakesAgain(11, seen)).toBe(false);
    // Before the fix the listener kept the number it started on.
    expect(wakesAgain(11, prev)).toBe(true);
  });

  it("a group message after the bot's last read but before the visit ends still wakes", () => {
    // The bot reads the group at t=40; a message lands at t=50; ends at 60.
    const samples: WakeSample[] = [
      { at: 35, wake: 10 },
      { at: 45, wake: 10 },
      { at: 55, wake: 11 },
    ];
    const seen = seenAfterWakeVisit({
      prev,
      samples,
      reads: [digest(4), groupRead(40)],
      groups: [groupMsg(50)],
    });
    expect(seen).toBe(10);
    expect(wakesAgain(11, seen)).toBe(true);
  });

  it("a group message after the last group read still wakes, even if the digest was read later", () => {
    // Starts on 11; reads the group at t=10; a second group message lands at
    // t=20 (-> 12); reads the digest at t=30, which never shows a group's
    // messages, and ends.
    const seen = seenAfterWakeVisit({
      prev: 11,
      samples: [
        { at: 5, wake: 11 },
        { at: 25, wake: 12 },
      ],
      reads: [groupRead(10), digest(30)],
      groups: [groupMsg(20)],
    });
    expect(seen).toBe(11);
    expect(wakesAgain(12, seen)).toBe(true);
  });

  it("a rise no group message explains needs a digest read after it", () => {
    // A reply lands at t=20 (10 -> 11), with no group message; the bot reads
    // only its group, at t=40.
    const samples: WakeSample[] = [
      { at: 15, wake: 10 },
      { at: 25, wake: 11 },
    ];
    expect(
      seenAfterWakeVisit({ prev, samples, reads: [groupRead(40)], groups: [] }),
    ).toBe(prev);
    // Reading the digest only before it isn't enough either.
    expect(
      seenAfterWakeVisit({
        prev,
        samples,
        reads: [digest(4), groupRead(40)],
        groups: [],
      }),
    ).toBe(prev);
    // A digest read after it is.
    expect(
      seenAfterWakeVisit({
        prev,
        samples,
        reads: [digest(30), groupRead(40)],
        groups: [],
      }),
    ).toBe(11);
  });

  it("a reply and a group message together need both read after them", () => {
    // Reply at t=20 and group message at t=22 (10 -> 12).
    const samples: WakeSample[] = [
      { at: 15, wake: 10 },
      { at: 25, wake: 12 },
      { at: 45, wake: 12 },
    ];
    const groups = [groupMsg(22)];
    // The group read at t=30 but the digest only at t=4: neither is seen.
    expect(
      seenAfterWakeVisit({
        prev,
        samples,
        reads: [digest(4), groupRead(30)],
        groups,
      }),
    ).toBe(prev);
    // Both read after them: both seen.
    expect(
      seenAfterWakeVisit({
        prev,
        samples,
        reads: [groupRead(30), digest(40)],
        groups,
      }),
    ).toBe(12);
  });

  it("a sample that came back after the read was sent doesn't count, even if close", () => {
    // The read went out at t=40; the sample at t=41 may hold a message that
    // landed while the read was on its way, after the site answered it.
    const seen = seenAfterWakeVisit({
      prev,
      samples: [
        { at: 39, wake: 10 },
        { at: 41, wake: 11 },
      ],
      reads: [groupRead(40)],
      groups: [groupMsg(40.5)],
    });
    expect(seen).toBe(10);
  });

  it("a NaN read keeps the number it had", () => {
    const reads = [digest(40), groupRead(40)];
    expect(
      seenAfterWakeVisit({
        prev,
        samples: [
          { at: 20, wake: Number.NaN },
          { at: 30, wake: Number.NaN },
        ],
        reads,
        groups: [groupMsg(10)],
      }),
    ).toBe(prev);
    // A finite sample before the read still counts; a NaN after it is passed
    // over, never taken as seen.
    expect(
      seenAfterWakeVisit({
        prev,
        samples: [
          { at: 20, wake: 11 },
          { at: 45, wake: Number.NaN },
        ],
        reads,
        groups: [groupMsg(10)],
      }),
    ).toBe(11);
    // A listener that never got a number keeps none until it gets one, and
    // with no number to measure a rise from it asks for the digest too.
    expect(
      seenAfterWakeVisit({
        prev: Number.NaN,
        samples: [{ at: 20, wake: Number.NaN }],
        reads,
        groups: [],
      }),
    ).toBeNaN();
    expect(
      seenAfterWakeVisit({
        prev: Number.NaN,
        samples: [{ at: 20, wake: 12 }],
        reads: [groupRead(40)],
        groups: [groupMsg(10)],
      }),
    ).toBeNaN();
    expect(
      seenAfterWakeVisit({
        prev: Number.NaN,
        samples: [{ at: 20, wake: 12 }],
        reads,
        groups: [groupMsg(10)],
      }),
    ).toBe(12);
  });

  it("a visit with no read of where things arrived keeps the number it started from", () => {
    const samples: WakeSample[] = [{ at: 20, wake: 11 }];
    expect(
      seenAfterWakeVisit({ prev, samples, reads: [], groups: [groupMsg(10)] }),
    ).toBe(prev);
    // Another group's read doesn't stand for this one.
    expect(
      seenAfterWakeVisit({
        prev,
        samples,
        reads: [{ scope: "channel:8", at: 40 }],
        groups: [groupMsg(10)],
      }),
    ).toBe(prev);
  });

  it("never goes below the number it started from", () => {
    expect(
      seenAfterWakeVisit({
        prev,
        samples: [{ at: 20, wake: 7 }],
        reads: [digest(40)],
        groups: [],
      }),
    ).toBe(prev);
  });
});

describe("which host calls are reads of a bot's arrivals", () => {
  const base = "http://127.0.0.1:3555";
  const sent = "2026-11-13T10:00:00.000Z";
  const entry = (over: Record<string, unknown>) => ({
    kind: "http",
    at: "2026-11-13T10:00:01.000Z",
    method: "GET",
    url: `${base}/v1/me/digest`,
    status: 200,
    sent_at: sent,
    ...over,
  });
  const at = Date.parse(sent);

  it("counts the digest and a private channel's newest messages, by when they went out", () => {
    for (const [url, scope] of [
      [`${base}/v1/me/digest`, "digest"],
      [`${base}/v1/me/digest?since=12&view=compact`, "digest"],
      [`${base}/v1/private-channels/7`, G],
      [`${base}/v1/private-channels/7?after=12&view=compact`, G],
    ])
      expect(arrivalRead(entry({ url }))).toEqual({ scope, at });
  });

  it("leaves out writes, refusals, pages back, other reads and entries with no send time", () => {
    for (const over of [
      { method: "POST", url: `${base}/v1/messages` },
      { status: 429 },
      { status: 401 },
      { url: `${base}/v1/private-channels/7?before=13` },
      { url: `${base}/v1/private-channels?with=quill` },
      { url: `${base}/v1/messages?with=scout` },
      { url: `${base}/v1/me/wake` },
      { url: `${base}/v1/messages/5/report` },
      { url: `${base}/v1/posts?sort=new` },
      { url: `${base}/api/v1/channels/private:7/messages` },
      { url: "not a url" },
      { sent_at: undefined },
      { kind: "http_refused" },
      { kind: "wait" },
    ])
      expect(arrivalRead(entry(over))).toBeUndefined();
  });
});

describe("the host's HTTP tool", () => {
  let inbox: HostInbox | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    await inbox?.close();
    inbox = undefined;
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  it("logs when each request went out, before it was answered", async () => {
    server = createServer((_req, res) => {
      setTimeout(() => res.end("{}"), 50);
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    inbox = await startHostInbox();
    const client = new Client({ name: "story-wake-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", path.join(process.cwd(), "evals/stories/host-mcp.ts")],
        env: {
          PATH: process.env.PATH ?? "",
          HOST_HTTP_ALLOW: origin,
          HOST_INBOX: inbox.urlFor("scout"),
        },
        stderr: "ignore",
      }),
    );
    try {
      await client.callTool({
        name: "http_request",
        arguments: { method: "GET", url: `${origin}/v1/me/digest` },
      });
    } finally {
      await client.close();
    }
    const [e] = inbox.entries("scout");
    if (!e) throw new Error("the host logged nothing");
    expect(e.kind).toBe("http");
    const read = arrivalRead(e);
    expect(read?.scope).toBe("digest");
    expect(read?.at).toBeLessThanOrEqual(Date.parse(e.at));
  }, 30_000);
});

describe("a group's arrivals, from the trial's database", () => {
  beforeEach(resetDb);

  type Bot = { handle: string; key: string };
  const wake = async (who: Bot): Promise<number> =>
    (await call(wakeRoute, { key: who.key })).body.wake;
  const send = (from: Bot, channel: string, body: string) =>
    call(sendRoute, { key: from.key, body: { channel, body } });

  it("counts what the site counted into the bot's wake number, and no more", async () => {
    const bots: Bot[] = [];
    for (const handle of ["scout", "quill", "duet"]) {
      const b = await register(handle);
      await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
      bots.push(b);
    }
    const [scout, quill, duet] = bots as [Bot, Bot, Bot];
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-wake') RETURNING id`;
    await db()`UPDATE bots SET owner_id = ${Number(h?.id)}`;
    const { channel } = await startChannel(
      db(),
      "google-wake",
      ["scout", "quill", "duet"],
      "duet",
      null,
    );
    const scope = `channel:${channel.replace("private:", "")}`;
    // Before `since`: in the number the listener started from.
    expect((await send(duet, channel, "before")).status).toBe(201);
    const before = await wake(scout);
    await new Promise((r) => setTimeout(r, 20));
    const since = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    // scout's own message doesn't raise its number; a blocked bot's doesn't.
    expect((await send(scout, channel, "mine")).status).toBe(201);
    expect(
      (await call(blockRoute, { key: scout.key, params: { handle: "quill" } }))
        .status,
    ).toBeLessThan(300);
    expect((await send(quill, channel, "blocked")).status).toBe(201);
    expect((await send(duet, channel, "one")).status).toBe(201);
    expect((await send(duet, channel, "two")).status).toBe(201);
    const got = await groupArrivals(db(), scout.key, since);
    expect(got.map((g) => g.scope)).toEqual([scope, scope]);
    expect(await wake(scout)).toBe(before + got.length);
    for (const g of got) expect(g.at).toBeGreaterThan(since);
    // Another key's bot sees its own.
    expect(await groupArrivals(db(), duet.key, since)).toHaveLength(2);
  });
});
