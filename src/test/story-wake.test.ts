import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import { db } from "@/lib/db";
import { startChannel } from "@/lib/private-channels";
import { type HostInbox, startHostInbox } from "../../evals/stories/inbox";
import {
  type ArrivalRead,
  arrivalRead,
  type GroupArrival,
  groupArrivals,
  messageIdsIn,
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
const digest = (at: number): ArrivalRead => ({ scope: "digest", at });
// A read of the group, sent at `at`, whose answer held these message ids.
const groupRead = (at: number, ...ids: number[]): ArrivalRead => ({
  scope: G,
  at,
  ids,
});
// Another member's message in the group, written at `at`.
const groupMsg = (id: number, at: number): GroupArrival => ({
  scope: G,
  id,
  at,
});

describe("what a wake visit leaves as seen", () => {
  // The visit starts at t=0 on number 10, taken just before (prev).
  const prev = 10;

  it("a group message during the visit that the bot then read wakes nothing", () => {
    // Message 21 lands at t=20 (10 -> 11); the bot reads the digest at t=4
    // and the group at t=12 (nothing new) and t=40 (21); the visit ends at
    // t=60, still on 11.
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
      reads: [digest(4), groupRead(12), groupRead(40, 21)],
      groups: [groupMsg(21, 20)],
    });
    expect(seen).toBe(11);
    expect(wakesAgain(11, seen)).toBe(false);
    // Before the fix the listener kept the number it started on.
    expect(wakesAgain(11, prev)).toBe(true);
  });

  it("a group message after the bot's last read but before the visit ends still wakes", () => {
    // The bot reads the group at t=40; message 21 lands at t=50; ends at 60.
    const samples: WakeSample[] = [
      { at: 35, wake: 10 },
      { at: 45, wake: 10 },
      { at: 55, wake: 11 },
    ];
    const seen = seenAfterWakeVisit({
      prev,
      samples,
      reads: [digest(4), groupRead(40, 20)],
      groups: [groupMsg(21, 50)],
    });
    expect(seen).toBe(10);
    expect(wakesAgain(11, seen)).toBe(true);
  });

  it("a group read sent after a message that didn't return it shows nothing of it", () => {
    // Message 21 lands at t=20 (10 -> 11); the bot posts its own 22 at t=30
    // without having read it; its read at t=40 has no cursor, so it starts
    // after 22 and returns nothing.
    const samples: WakeSample[] = [
      { at: 15, wake: 10 },
      { at: 25, wake: 11 },
      { at: 55, wake: 11 },
    ];
    const seen = seenAfterWakeVisit({
      prev,
      samples,
      reads: [groupRead(10), groupRead(40)],
      groups: [groupMsg(21, 20)],
    });
    expect(seen).toBe(10);
    expect(wakesAgain(11, seen)).toBe(true);
    // A page that returned it (paging back, say) shows it.
    expect(
      seenAfterWakeVisit({
        prev,
        samples,
        reads: [groupRead(10), groupRead(40), groupRead(45, 19, 21)],
        groups: [groupMsg(21, 20)],
      }),
    ).toBe(11);
  });

  it("of two messages, one returned and one not, only the first is seen", () => {
    // 21 at t=20 (-> 11), read at t=30; 23 at t=40 (-> 12), never returned.
    const seen = seenAfterWakeVisit({
      prev,
      samples: [
        { at: 25, wake: 11 },
        { at: 35, wake: 11 },
        { at: 45, wake: 12 },
      ],
      reads: [groupRead(30, 21), groupRead(50, 24)],
      groups: [groupMsg(21, 20), groupMsg(23, 40)],
    });
    expect(seen).toBe(11);
    expect(wakesAgain(12, seen)).toBe(true);
  });

  it("a group message after the last group read still wakes, even if the digest was read later", () => {
    // Starts on 11; reads the group at t=10; message 21 lands at t=20
    // (-> 12); reads the digest at t=30, which never shows a group's
    // messages, and ends.
    const seen = seenAfterWakeVisit({
      prev: 11,
      samples: [
        { at: 5, wake: 11 },
        { at: 25, wake: 12 },
      ],
      reads: [groupRead(10, 19), digest(30)],
      groups: [groupMsg(21, 20)],
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

  it("a reply and a group message together need both shown", () => {
    // Reply at t=20 and group message 21 at t=22 (10 -> 12).
    const samples: WakeSample[] = [
      { at: 15, wake: 10 },
      { at: 25, wake: 12 },
      { at: 45, wake: 12 },
    ];
    const groups = [groupMsg(21, 22)];
    // The group returned it at t=30 but the digest was read only at t=4.
    expect(
      seenAfterWakeVisit({
        prev,
        samples,
        reads: [digest(4), groupRead(30, 21)],
        groups,
      }),
    ).toBe(prev);
    // Both shown after them: both seen.
    expect(
      seenAfterWakeVisit({
        prev,
        samples,
        reads: [groupRead(30, 21), digest(40)],
        groups,
      }),
    ).toBe(12);
  });

  it("a sample that came back after an unshown message was written doesn't count, even if close", () => {
    const seen = seenAfterWakeVisit({
      prev,
      samples: [
        { at: 39, wake: 10 },
        { at: 41, wake: 11 },
      ],
      reads: [groupRead(40)],
      groups: [groupMsg(21, 40.5)],
    });
    expect(seen).toBe(10);
    // ...nor one that came back after a digest read was sent.
    expect(
      seenAfterWakeVisit({
        prev,
        samples: [
          { at: 39, wake: 10 },
          { at: 41, wake: 11 },
        ],
        reads: [digest(40)],
        groups: [],
      }),
    ).toBe(10);
  });

  it("a NaN read keeps the number it had", () => {
    const reads = [digest(40), groupRead(40, 21)];
    const groups = [groupMsg(21, 10)];
    expect(
      seenAfterWakeVisit({
        prev,
        samples: [
          { at: 20, wake: Number.NaN },
          { at: 30, wake: Number.NaN },
        ],
        reads,
        groups,
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
        groups,
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
        reads: [groupRead(40, 21)],
        groups,
      }),
    ).toBeNaN();
    expect(
      seenAfterWakeVisit({
        prev: Number.NaN,
        samples: [{ at: 20, wake: 12 }],
        reads,
        groups,
      }),
    ).toBe(12);
  });

  it("a visit with no read of where things arrived keeps the number it started from", () => {
    const samples: WakeSample[] = [{ at: 20, wake: 11 }];
    expect(
      seenAfterWakeVisit({
        prev,
        samples,
        reads: [],
        groups: [groupMsg(21, 10)],
      }),
    ).toBe(prev);
    // Another group's read doesn't stand for this one, even holding that id.
    expect(
      seenAfterWakeVisit({
        prev,
        samples,
        reads: [{ scope: "channel:8", at: 40, ids: [21] }],
        groups: [groupMsg(21, 10)],
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

  it("counts the digest by when it went out, and a private channel by what it returned", () => {
    for (const url of [
      `${base}/v1/me/digest`,
      `${base}/v1/me/digest?since=12&view=compact`,
    ])
      expect(arrivalRead(entry({ url }))).toEqual({ scope: "digest", at });
    for (const url of [
      `${base}/v1/private-channels/7`,
      `${base}/v1/private-channels/7?after=12&view=compact`,
      `${base}/v1/private-channels/7?before=13`,
    ])
      expect(arrivalRead(entry({ url, message_ids: [12, 13] }))).toEqual({
        scope: G,
        at,
        ids: [12, 13],
      });
    // An entry with no ids (an older host, or a cut answer) returned none.
    expect(
      arrivalRead(entry({ url: `${base}/v1/private-channels/7` })),
    ).toEqual({ scope: G, at, ids: [] });
    expect(
      arrivalRead(
        entry({ url: `${base}/v1/private-channels/7`, message_ids: ["9", 4] }),
      ),
    ).toEqual({ scope: G, at, ids: [4] });
  });

  it("leaves out writes, refusals, other reads and entries with no send time", () => {
    for (const over of [
      { method: "POST", url: `${base}/v1/messages` },
      { status: 429 },
      { status: 401 },
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

  it("reads message ids only from a whole answer", () => {
    expect(
      messageIdsIn(JSON.stringify({ messages: [{ id: 3 }, { id: 5 }] })),
    ).toEqual([3, 5]);
    const whole = JSON.stringify({
      messages: [{ id: 3 }, { id: 5, untrusted_body: "x".repeat(100) }],
    });
    expect(messageIdsIn(whole.slice(0, 60))).toEqual([]);
    expect(messageIdsIn("not json")).toEqual([]);
    expect(messageIdsIn(JSON.stringify({ error: { code: "x" } }))).toEqual([]);
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

  it("logs when each request went out, and which messages a channel's answer held", async () => {
    server = createServer((req, res) => {
      const body = req.url?.startsWith("/v1/private-channels/")
        ? JSON.stringify({ messages: [{ id: 4 }, { id: 9 }] })
        : "{}";
      setTimeout(() => res.end(body), 50);
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
      await client.callTool({
        name: "http_request",
        arguments: { method: "GET", url: `${origin}/v1/private-channels/7` },
      });
    } finally {
      await client.close();
    }
    const [e, c] = inbox.entries("scout");
    if (!e || !c) throw new Error("the host logged too little");
    expect(e.kind).toBe("http");
    const read = arrivalRead(e);
    expect(read?.scope).toBe("digest");
    expect(read?.at).toBeLessThanOrEqual(Date.parse(e.at));
    expect(e.message_ids).toBeUndefined();
    expect(arrivalRead(c)).toMatchObject({ scope: G, ids: [4, 9] });
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

  it("a read with no cursor after the bot's own post doesn't count an earlier message as read", async () => {
    const bots: Bot[] = [];
    for (const handle of ["scout", "duet"]) {
      const b = await register(handle);
      await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
      bots.push(b);
    }
    const [scout, duet] = bots as [Bot, Bot];
    await db()`INSERT INTO humans (auth_user_id) VALUES ('google-wake2')`;
    await db()`UPDATE bots SET owner_id = (SELECT id FROM humans WHERE auth_user_id = 'google-wake2')`;
    const { channel } = await startChannel(
      db(),
      "google-wake2",
      ["scout", "duet"],
      "duet",
      null,
    );
    const id = channel.replace("private:", "");
    const readAs = async (who: Bot) => {
      const sentAt = Date.now();
      const r = await call(readRoute, {
        key: who.key,
        path: `/v1/private-channels/${id}`,
        params: { id },
      });
      expect(r.status).toBe(200);
      return {
        scope: `channel:${id}`,
        at: sentAt,
        ids: messageIdsIn(JSON.stringify(r.body)),
      };
    };
    const prev = await wake(scout);
    const since = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    const first = await readAs(scout);
    expect((await send(duet, channel, "M")).status).toBe(201);
    await new Promise((r) => setTimeout(r, 20));
    const sample = { at: Date.now(), wake: await wake(scout) };
    expect(sample.wake).toBe(prev + 1);
    expect((await send(scout, channel, "mine")).status).toBe(201);
    const second = await readAs(scout);
    const groups = await groupArrivals(db(), scout.key, since);
    expect(groups).toHaveLength(1);
    // The read went out after M but started after scout's own post.
    expect(second.ids).not.toContain(groups[0]?.id);
    const seen = seenAfterWakeVisit({
      prev,
      samples: [sample],
      reads: [first, second],
      groups,
    });
    expect(seen).toBe(prev);
    expect(wakesAgain(sample.wake, seen)).toBe(true);
  });
});
