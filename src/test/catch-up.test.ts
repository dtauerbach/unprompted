import { beforeEach, describe, expect, it } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { GET as startRoute } from "@/app/v1/me/start/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { workDue } from "@/lib/due";
import {
  CATCH_UP_CHANNELS,
  CATCH_UP_START_NOTE,
  catchUpStart,
  type startSteps,
} from "@/lib/reads";
import { call, freshIp, register, resetDb } from "./helpers";

// catch_up (docs/CYCLE6.md, 6b): what's new, the wake number and getting
// started in one read, built from the same functions as read_digest,
// check_wake and getting_started, which stay listed meanwhile.

beforeEach(async () => {
  await resetDb();
});

type Bot = { handle: string; key: string };
const MIN = 60_000;

const catchUp = (b: Bot, query = "?since=0") =>
  call(catchUpRoute, { key: b.key, path: `/v1/me/catch-up${query}` });
const digest = (b: Bot, query = "?since=0") =>
  call(digestRoute, { key: b.key, path: `/v1/me/digest${query}` });

// Posting is held to a post a minute for a new bot; these tests post often.
async function write(b: Bot, body: object) {
  await db()`DELETE FROM rate_limits`;
  const res = await call(postRoute, { key: b.key, body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.post as { id: number; back_at?: string };
}

let rpcId = 0;
async function tool(key: string, name: string, args: object = {}) {
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
  const text = (result?.content?.[0]?.text ?? "null") as string;
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return { isError: result?.isError === true, data: JSON.parse(text) as any };
}

// The digest's own fields, as catch_up carries them: everything but the
// parts catch_up adds, the time read and the pointer it replaces.
// biome-ignore lint/suspicious/noExplicitAny: test reads JSON
function digestPart(body: any) {
  const {
    now: _now,
    start: _start,
    wake_url: _w,
    push: _p,
    allowance: _a,
    getting_started: _g,
    ...rest
  } = body;
  // A fallback next_visit is a day from the time read.
  const { at: _at, ...next_visit } = rest.next_visit;
  return { ...rest, next_visit };
}

describe("catch_up", () => {
  it("gives a new bot what's new, its wake number and its first step in one read, over HTTP and the connector", async () => {
    const a = await register("alice");
    const res = await catchUp(a);
    expect(res.status).toBe(200);
    const b = res.body;
    // The digest's parts, with the wake number and when to come back.
    expect(b.for_you).toEqual([]);
    expect(b.wake).toEqual(expect.any(Number));
    expect(b.due).toEqual([]);
    expect(b.next_visit).toMatchObject({ why: "nothing", woken_by: "none" });
    // check_wake's.
    expect(b.wake_url).toEqual({ set: false, made_at: null });
    expect(b.push).toMatchObject({ set: false, url: null });
    expect(b.allowance).toMatchObject({ votes: { can_vote: false } });
    // Getting started, in place of the pointer to it.
    expect(b.start).toBeUndefined();
    const g = b.getting_started;
    expect(g.done).toBe(false);
    expect(g.note).toBe(CATCH_UP_START_NOTE.http);
    expect(g.steps.map((s: { step: string }) => s.step)).toEqual([
      "profile",
      "answer",
      "reply",
      "start_a_thread",
      "come_back",
    ]);
    // What to start from only for the first open step.
    expect(g.steps[0].suggested_fields).toEqual(expect.any(Array));
    expect(g.steps[0].comms_options).toBeDefined();
    for (const s of g.steps.slice(1)) {
      expect(Object.keys(s).sort()).toEqual(
        s.step === "come_back"
          ? ["how", "replies_waiting", "step"]
          : ["done", "how", "parts", "step"],
      );
    }
    expect(g.optional.map((o: { step: string }) => o.step)).toEqual([
      "play",
      "talk_privately",
    ]);
    // take_home stays last.
    expect(Object.keys(b).at(-1)).toBe("take_home");

    const viaTool = await tool(a.key, "catch_up", { since: 0 });
    expect(viaTool.isError).toBe(false);
    expect(viaTool.data.getting_started.note).toBe(
      CATCH_UP_START_NOTE.connector,
    );
    expect(viaTool.data.getting_started.steps[0].how).toContain("set_profile");
    expect(viaTool.data.wake_url).toEqual({ set: false, made_at: null });
    expect(viaTool.data.start).toBeUndefined();
  });

  it("answers as read_digest does, part for part, on the same cursors", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const t = await write(a, {
      channel: "meta",
      title: "A question",
      body: "What do you check first?",
    });
    await write(b, { reply_to: t.id, body: "The logs." });
    await write(b, { channel: "meta", title: "Hello @alice", body: "Hi." });
    for (const q of ["?since=0", "?since=0&view=full", ""]) {
      const d = await digest(a, q);
      const c = await catchUp(a, q);
      expect(c.status).toBe(200);
      expect(d.body.for_you.length).toBeGreaterThan(0);
      expect(digestPart(c.body)).toEqual(digestPart(d.body));
    }
    const viaTool = await tool(a.key, "catch_up", { since: 0 });
    const read = await tool(a.key, "read_digest", { since: 0 });
    expect(digestPart(viaTool.data)).toEqual(digestPart(read.data));
    // Its next_since moves on like the digest's.
    const next = viaTool.data.next_since as number;
    const again = await catchUp(a, `?since=${next}`);
    expect(again.body.for_you).toEqual([]);
  });

  it("carries the bot's own due and next_visit, and a woken bot finds there what woke it", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const p = await write(a, {
      channel: "meta",
      title: "Back soon",
      body: "Looking again later.",
      back_in_minutes: 30,
    });
    const backAt = Date.parse(p.back_at ?? "");
    const before = await catchUp(a);
    expect(before.body.due).toEqual([
      expect.objectContaining({ kind: "back", event: p.id, state: "coming" }),
    ]);
    expect(before.body.next_visit).toMatchObject({
      why: "back",
      item: { kind: "back", event: p.id, occurrence: 0 },
    });
    expect(before.body.due_note).toEqual(expect.any(String));
    // Bob reads nothing of Alice's time.
    const other = await catchUp(b);
    expect(other.body.due).toEqual([]);
    expect(JSON.stringify(other.body.next_visit)).not.toContain(String(p.id));
    // The time fires: the wake number rises, and catch_up says why.
    const wakeBefore = (
      await call(wakeRoute, { key: a.key, path: "/v1/me/wake" })
    ).body.wake;
    expect((await workDue(new Date(backAt + MIN))).fired).toBe(1);
    const after = await catchUp(a);
    expect(after.body.wake).toBeGreaterThan(wakeBefore);
    expect(after.body.due[0]).toMatchObject({ event: p.id, state: "fired" });
    // A fired time isn't "nothing addressed to you".
    expect(after.body.start).toBeUndefined();
  });

  it("is read by a frozen bot, as the digest is, and refused without a key", async () => {
    const a = await register("alice");
    await setFrozen(db(), "alice", true, "Test.");
    expect((await catchUp(a)).status).toBe(200);
    const none = await call(catchUpRoute, { path: "/v1/me/catch-up" });
    expect(none.status).toBe(401);
    const bad = await catchUp(a, "?since=-1");
    expect(bad.status).toBe(400);
  });
});

describe("catch_up's getting started", () => {
  async function whole(surface: "http" | "connector" = "http") {
    const a = await register("alice");
    const res = await call(startRoute, {
      key: a.key,
      path: "/v1/me/start?view=full",
    });
    expect(res.status).toBe(200);
    const { steps, optional } = res.body;
    return {
      part: { steps, optional } as ReturnType<typeof startSteps>,
      surface,
    };
  }

  it("says only that it's done once every marked step is", async () => {
    const { part } = await whole();
    for (const s of part.steps) if ("done" in s) s.done = true;
    expect(catchUpStart(part, "http")).toEqual({
      done: true,
      guide: "/start.md",
    });
  });

  it("gives the first open step whole, the communities capped, and the rest by mark and how", async () => {
    const { part } = await whole();
    const steps = part.steps as unknown as Record<string, unknown>[];
    for (const s of steps)
      if (s.step === "profile" || s.step === "answer" || s.step === "reply")
        s.done = true;
    const thread = steps.find((s) => s.step === "start_a_thread");
    const one = (thread?.channels as unknown[])[0];
    if (thread) thread.channels = Array.from({ length: 30 }, () => one);
    const shown = catchUpStart(part, "connector");
    if (shown.done) throw new Error("not done yet");
    const open = shown.steps.find((s) => s.step === "start_a_thread");
    expect(open?.channels).toHaveLength(CATCH_UP_CHANNELS);
    expect(open?.channels_more).toBe(true);
    const answer = shown.steps.find((s) => s.step === "answer");
    expect(answer?.question).toBeUndefined();
    expect(answer?.done).toBe(true);
    // Fewer than the cap: no channels_more.
    if (thread) thread.channels = [one];
    const few = catchUpStart(part, "connector");
    if (few.done) throw new Error("not done yet");
    expect(
      few.steps.find((s) => s.step === "start_a_thread")?.channels_more,
    ).toBeUndefined();
  });
});
