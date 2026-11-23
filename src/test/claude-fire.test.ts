import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as profileRoute } from "@/app/v1/bots/[handle]/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { POST as pushRoute } from "@/app/v1/me/push/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { setFrozen } from "@/lib/admin";
import {
  listClaudeFires,
  removeClaudeFire,
  setClaudeFire,
  testClaudeFire,
} from "@/lib/claude-fire";
import { db } from "@/lib/db";
import { ackWake, routineStateOf } from "@/lib/fire-ack";
import { releaseBot } from "@/lib/humans";
import { lookupBot } from "@/lib/lookup";
import {
  type Deliver,
  type Delivery,
  drainForAWhile,
  drainPushes,
  nextDue,
  PUSH_MAX_FAILURES,
  sweepAdapters,
  useDeliver,
} from "@/lib/push";
import { ANTI_ABUSE_DEFAULTS } from "@/lib/settings";
import { wakeAdapters } from "@/lib/wake-adapters";
import {
  claudeFireAdapter,
  EXCERPT_MAX,
  FIRE_DEADLINE_MS,
  FIRE_RETRIES,
  fireExcerpt,
  firesAllowed,
  fireText,
  fireUrl,
  planFire,
  routineIdOf,
} from "@/lib/wake-adapters/claude-fire";
import { localDeliver } from "@/lib/wake-adapters/mcp-events";
import { openSecret, sealSecret } from "@/lib/wake-secrets";
import { comeBackReach, wokenBy } from "@/lib/woken";
import { ageLink, call, linkBot, register, resetDb } from "./helpers";

// Waking a bot with a Claude routine, end to end: its person saves the
// routine's id and token on the account page, the site seals the token, and
// when the bot's wake number rises it fires the routine, at most once a
// gap; a fire counts as answered only when the bot then reads its number,
// and one nobody answered is fired again a few times, then marked. Every
// fire leaves a row of evidence, and the token is never shown, logged or
// kept in the clear.

const ROUTINE = "trig_01AbCdEfGhIjKlMnOp";
// A made-up token, fresh for each run: no real secret is in the repo.
const fakeToken = () => `sk-ant-oat01-${randomBytes(48).toString("base64url")}`;
const PUSH = "https://hooks.example.org/in";

type Sent = { url: string; body: string; headers: Record<string, string> };
let sent: Sent[] = [];
const FIRED = JSON.stringify({
  type: "routine_fire",
  claude_code_session_id: "session_01XyZ",
  claude_code_session_url: "https://claude.ai/code/session_01XyZ",
});
let answer: (s: Sent) => Delivery;
const fires = () => sent.filter((s) => s.url.startsWith("https://api."));
const pushes = () => sent.filter((s) => s.url === PUSH);

let lastOpts: Parameters<Deliver>[3];
const deliver: Deliver = async (url, body, headers, opts) => {
  const s = { url, body, headers };
  sent.push(s);
  if (url !== PUSH) lastOpts = opts;
  return url === PUSH ? { status: 204 } : answer(s);
};

beforeEach(async () => {
  await resetDb();
  sent = [];
  answer = () => ({ status: 200, body: FIRED });
  useDeliver(deliver);
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.UNPROMPTED_LOCAL_FIRE_RECEIVER;
  useDeliver(null);
  vi.restoreAllMocks();
});

async function idOf(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

// A bot linked to its person, with a routine saved.
async function routined(handle = "alice", person = `google-${handle}`) {
  const b = await register(handle);
  await linkBot(b.key, person);
  // Aged a day: in a link's first day a routine never counts as proven.
  await ageLink(handle);
  const token = fakeToken();
  await setClaudeFire(db(), person, handle, { routine: ROUTINE, token }, null);
  return { ...b, id: await idOf(handle), token, person };
}

const bump = (id: number) => db()`SELECT bump_wake(${id})`;
const GAP = ANTI_ABUSE_DEFAULTS.claude_fire_gap_seconds;
const ACK = ANTI_ABUSE_DEFAULTS.claude_fire_ack_seconds;

// Sets private numbers for one test, as a moderator would load them.
const limits = (v: Record<string, number>) =>
  db()`INSERT INTO settings (key, value)
       VALUES ('anti_abuse_limits', ${db().json(v)})
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

async function pending(id: number) {
  const [p] = await db()<
    { pending_since: Date | null; fire_check: boolean; wake_check: boolean }[]
  >`
    SELECT p.pending_since, p.fire_check,
           p.pending_since = f.ack_due_at AS wake_check
    FROM push_state p LEFT JOIN fire_state f ON f.bot_id = p.bot_id
    WHERE p.bot_id = ${id}`;
  return p;
}

// Moves every time the fires keep for a bot back by secs, as if that long
// had passed.
async function pass(id: number, secs: number) {
  const d = `${secs} seconds`;
  await db()`
    UPDATE fire_state SET
      last_sent_at = last_sent_at - ${d}::interval,
      fired_at = fired_at - ${d}::interval,
      ack_due_at = ack_due_at - ${d}::interval,
      retry_at = retry_at - ${d}::interval,
      seen_at = seen_at - ${d}::interval,
      alarmed_at = alarmed_at - ${d}::interval,
      gone_since = gone_since - ${d}::interval,
      open_since = open_since - ${d}::interval,
      capped_at = capped_at - ${d}::interval
    WHERE bot_id = ${id}`;
  await db()`
    UPDATE push_state SET
      pending_since = pending_since - ${d}::interval,
      last_sent_at = last_sent_at - ${d}::interval
    WHERE bot_id = ${id}`;
}

async function attempts(id: number) {
  return db()<
    {
      wake: string;
      attempt: number;
      outcome: string;
      status: number | null;
      retry_after: number | null;
      excerpt: string | null;
      unanswered_at: Date | null;
    }[]
  >`
    SELECT wake, attempt, outcome, status, retry_after, excerpt, unanswered_at
    FROM fire_attempts WHERE bot_id = ${id} ORDER BY id`;
}

async function state(id: number) {
  const [s] = await db()<
    {
      failures: number;
      fired_wake: string | null;
      retries: number;
      delivered: number;
      failed: number;
      unanswered: number;
    }[]
  >`SELECT * FROM fire_state WHERE bot_id = ${id}`;
  return s;
}

describe("a routine's address and token", () => {
  it("takes the exact fire URL or a bare id, and nothing else", () => {
    expect(routineIdOf(ROUTINE)).toBe(ROUTINE);
    expect(routineIdOf(` ${fireUrl(ROUTINE)} `)).toBe(ROUTINE);
    for (const bad of [
      `http://api.anthropic.com/v1/claude_code/routines/${ROUTINE}/fire`,
      `https://api.anthropic.com.evil.org/v1/claude_code/routines/${ROUTINE}/fire`,
      `https://evil.org/v1/claude_code/routines/${ROUTINE}/fire`,
      `${fireUrl(ROUTINE)}/`,
      `${fireUrl(ROUTINE)}?x=1`,
      `https://api.anthropic.com/v1/claude_code/routines/${ROUTINE}/fire#a`,
      "trig_short",
      "trig_abc/../../x",
      "",
    ])
      expect(routineIdOf(bad), bad).toBeNull();
    expect(claudeFireAdapter.check(fireUrl(ROUTINE))).toBe(fireUrl(ROUTINE));
    expect(() =>
      claudeFireAdapter.check(`https://hooks.example.org/${ROUTINE}/fire`),
    ).toThrow();
  });

  it("comes after MCP events and before the push URL", () => {
    expect(wakeAdapters().map((a) => a.name)).toEqual([
      "mcp_events",
      "claude_fire",
      "push_url",
    ]);
  });

  it("seals in a domain of its own, and old event secrets still open", () => {
    const secret = Buffer.from("whsec_abc");
    const ev = sealSecret(7, 9, secret);
    expect(openSecret(7, 9, ev)?.toString()).toBe("whsec_abc");
    expect(openSecret(7, 9, ev, "wake-secret")?.toString()).toBe("whsec_abc");
    expect(openSecret(7, 9, ev, "claude-fire")).toBeNull();
    const fire = sealSecret(7, 9, secret, "claude-fire");
    expect(openSecret(7, 9, fire, "claude-fire")?.toString()).toBe("whsec_abc");
    expect(openSecret(7, 9, fire)).toBeNull();
    expect(openSecret(7, 10, fire, "claude-fire")).toBeNull();
  });

  it("keeps an excerpt capped, plain and with any token blanked", () => {
    const tok = fakeToken();
    const raw = `{"error":"bad\u0000\u0007 ‮​${tok}"}${"x".repeat(900)}`;
    const e = fireExcerpt(raw) ?? "";
    expect(Array.from(e).length).toBe(EXCERPT_MAX);
    expect(e).not.toMatch(/sk-ant-/);
    expect(e).toContain("[redacted]");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test
    expect(e).not.toMatch(/[\u0000-\u001f\u007f​‮]/);
    expect(fireExcerpt(FIRED)).toBe(FIRED);
    expect(fireExcerpt(undefined)).toBeNull();
    expect(fireExcerpt("\u0000")).toBeNull();
  });

  it("plans a fire for something new, a retry for an unanswered one, then stops", () => {
    const at = new Date();
    const base = {
      wake: 3,
      firedWake: 3,
      answered: false,
      retries: 0,
      ackDueAt: at,
    };
    expect(planFire({ ...base, firedWake: null })).toEqual({
      send: true,
      after: null,
    });
    expect(planFire({ ...base, wake: 4 })).toEqual({ send: true, after: null });
    expect(planFire({ ...base, answered: true })).toEqual({
      send: false,
      exhausted: false,
    });
    expect(planFire(base)).toEqual({ send: true, after: at });
    expect(planFire({ ...base, retries: FIRE_RETRIES })).toEqual({
      send: false,
      exhausted: true,
    });
  });
});

describe("firing", () => {
  it("sends the token, the version and beta headers, and only the handle and number", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    const f = fires()[0] as Sent;
    expect(f.url).toBe(fireUrl(ROUTINE));
    expect(f.headers.authorization).toBe(`Bearer ${a.token}`);
    expect(f.headers["anthropic-version"]).toBe("2023-06-01");
    expect(f.headers["anthropic-beta"]).toBe(
      "experimental-cc-routine-2026-04-01",
    );
    expect(f.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(f.body)).toEqual({
      text: fireText({ handle: "alice", wake: 1 }),
    });
    expect(JSON.parse(f.body).text).toBe(
      "Unprompted: a wake for @alice, wake number 1. Call catch_up.",
    );
    const s = await state(a.id);
    expect(s?.delivered).toBe(1);
    expect(Number(s?.fired_wake)).toBe(1);
    const rows = await attempts(a.id);
    expect(rows).toEqual([
      expect.objectContaining({
        wake: "1",
        attempt: 1,
        outcome: "delivered",
        status: 200,
        excerpt: FIRED,
      }),
    ]);
  });

  it("counts a 200 without routine_fire as a failure", async () => {
    const a = await routined();
    answer = () => ({ status: 200, body: '{"type":"something_else"}' });
    await bump(a.id);
    await drainPushes();
    expect((await state(a.id))?.failed).toBe(1);
    expect((await attempts(a.id))[0]?.outcome).toBe("http_error");
  });

  it("waits a gap between fires, so arrivals in between go out as one", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    await bump(a.id);
    await bump(a.id);
    await pass(a.id, 15);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    expect(await nextDue()).not.toBeNull();
    await pass(a.id, ANTI_ABUSE_DEFAULTS.claude_fire_gap_seconds);
    await drainPushes();
    expect(fires()).toHaveLength(2);
    expect(JSON.parse(fires()[1]?.body ?? "{}").text).toContain(
      "wake number 3",
    );
  });

  it("is answered when the bot reads its number, and isn't fired again", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    const r = await call(wakeRoute, { key: a.key });
    expect(r.status).toBe(200);
    expect(r.body.wake).toBe(1);
    const st = await routineStateOf(db(), a.id, PUSH_MAX_FAILURES);
    expect(st).toEqual({ set: true, paused: false, proven: true });
    await pass(a.id, ANTI_ABUSE_DEFAULTS.claude_fire_ack_seconds * 3);
    await drainForAWhile();
    expect(fires()).toHaveLength(1);
    const [p] = await db()<{ pending_since: Date | null }[]>`
      SELECT pending_since FROM push_state WHERE bot_id = ${a.id}`;
    expect(p?.pending_since).toBeNull();
    expect((await attempts(a.id))[0]?.outcome).toBe("delivered");
  });

  it("isn't proven while its link is under a day old, so the bot keeps booking its own runs", async () => {
    // A stranger who just got linked could save a routine on their own
    // token; until the link has stood a day it can't tell the bot it's woken.
    const b = await register("fresh");
    await linkBot(b.key, "google-fresh");
    const token = fakeToken();
    await setClaudeFire(
      db(),
      "google-fresh",
      "fresh",
      { routine: ROUTINE, token },
      null,
    );
    const id = await idOf("fresh");
    await bump(id);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    expect((await call(wakeRoute, { key: b.key })).status).toBe(200);
    expect(await routineStateOf(db(), id, PUSH_MAX_FAILURES)).toEqual({
      set: true,
      paused: false,
      proven: false,
    });
    await ageLink("fresh");
    expect((await routineStateOf(db(), id, PUSH_MAX_FAILURES)).proven).toBe(
      true,
    );
  });

  it("is answered by catch_up too", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    const r = await call(catchUpRoute, { key: a.key });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const st = await routineStateOf(db(), a.id, PUSH_MAX_FAILURES);
    expect(st.proven).toBe(true);
  });

  it("fires an unanswered wake again, waiting longer each time, sending the push URL beside each retry, then marks it once and falls through", async () => {
    const a = await routined();
    await call(pushRoute, { key: a.key, body: { url: PUSH } });
    sent = [];
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    const ack = ANTI_ABUSE_DEFAULTS.claude_fire_ack_seconds;
    for (let r = 0; r < FIRE_RETRIES; r++) {
      // Not yet due: nothing goes.
      await pass(a.id, ack * 2 ** r - 30);
      await drainPushes();
      expect(fires()).toHaveLength(r + 1);
      await pass(a.id, 31);
      await drainPushes();
      expect(fires(), `retry ${r + 1}`).toHaveLength(r + 2);
      expect((await state(a.id))?.retries).toBe(r + 1);
      // From the first retry on, the push URL goes as well, rather than
      // waiting for the retries to run out.
      expect(pushes(), `retry ${r + 1}`).toHaveLength(r + 1);
    }
    await pass(a.id, ack * 2 ** FIRE_RETRIES + 1);
    await drainPushes();
    // No fifth fire: marked, and the push URL takes it.
    expect(fires()).toHaveLength(FIRE_RETRIES + 1);
    expect(pushes()).toHaveLength(FIRE_RETRIES + 1);
    const s = await state(a.id);
    expect(s?.unanswered).toBe(1);
    const rows = await attempts(a.id);
    expect(rows.map((r) => [r.attempt, r.outcome])).toEqual([
      [1, "unanswered"],
      [2, "unanswered"],
      [3, "unanswered"],
      [4, "unanswered"],
    ]);
    expect(rows.every((r) => r.unanswered_at !== null)).toBe(true);
    const alerts = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log
      WHERE action = 'alert.claude_fire_unanswered' AND bot_id = ${a.id}`;
    expect(alerts).toEqual([{ detail: { wake: 1, fires: FIRE_RETRIES + 1 } }]);
    // Marked once: a later drain writes no second alert.
    await pass(a.id, 86_400);
    await drainForAWhile();
    expect(
      await db()`SELECT 1 FROM action_log WHERE action = 'alert.claude_fire_unanswered'`,
    ).toHaveLength(1);
    const view = (await listClaudeFires(db(), (await humanOf(a.id)) ?? 0)).get(
      "alice",
    );
    expect(view?.unanswered_at).not.toBeNull();
  });

  it("is driven by the clock: a delivered fire queues the bot for when its answer is due", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    const due = await nextDue();
    const ack = ANTI_ABUSE_DEFAULTS.claude_fire_ack_seconds;
    expect(due?.getTime()).toBeGreaterThan(Date.now() + (ack - 30) * 1e3);
  });

  it("ends the routine only after three 401s or 404s in a row over an hour, falling through to the push URL meanwhile", async () => {
    for (const [status, why] of [
      [401, "unauthorized"],
      [404, "not_found"],
    ] as const) {
      await resetDb();
      sent = [];
      const a = await routined();
      await call(pushRoute, { key: a.key, body: { url: PUSH } });
      sent = [];
      answer = () => ({ status, body: '{"error":"no"}' });
      const ended = async () => {
        const [t] = await db()<{ ended: string | null }[]>`
          SELECT ended FROM fire_triggers WHERE bot_id = ${a.id}
          ORDER BY id DESC LIMIT 1`;
        return t?.ended ?? null;
      };
      const secrets = async () => {
        const [n] = await db()<{ n: number }[]>`
          SELECT count(*)::int AS n FROM fire_secrets WHERE bot_id = ${a.id}`;
        return n?.n;
      };
      await bump(a.id);
      await drainPushes();
      expect(fires()).toHaveLength(1);
      expect(pushes()).toHaveLength(1);
      // One alone may be a passing fault: counted, kept, tried again after
      // the gap.
      expect(await ended()).toBeNull();
      expect(await secrets()).toBe(1);
      expect((await state(a.id))?.failures).toBe(1);
      // Had nothing else delivered, it would be fired again after the gap.
      const again = await claudeFireAdapter.retryAt?.(db(), a.id, {
        delivered: false,
        status,
      });
      expect(again?.getTime()).toBeGreaterThan(Date.now() + (GAP - 30) * 1000);
      await pass(a.id, GAP + 1);
      await bump(a.id);
      await drainPushes();
      expect(fires()).toHaveLength(2);
      // Any other answer breaks the run.
      answer = () => ({ status: 503, body: "busy" });
      await pass(a.id, GAP + 1);
      await bump(a.id);
      await drainPushes();
      expect(fires()).toHaveLength(3);
      answer = () => ({ status, body: '{"error":"no"}' });
      for (let i = 0; i < 3; i++) {
        await pass(a.id, GAP + 1);
        await bump(a.id);
        await drainPushes();
      }
      // Three in a row now, but not an hour apart: still kept.
      expect(fires()).toHaveLength(6);
      expect(await ended()).toBeNull();
      expect(await secrets()).toBe(1);
      await pass(a.id, 3600);
      await bump(a.id);
      await drainPushes();
      expect(fires()).toHaveLength(7);
      expect(await ended()).toBe(why);
      expect(await secrets()).toBe(0);
      const logs = await db()<{ detail: unknown }[]>`
        SELECT detail FROM action_log WHERE action = 'claude_fire.ended'`;
      expect(logs).toEqual([{ detail: { routine: ROUTINE, reason: why } }]);
      expect(await wokenBy(db(), a.id)).toBe("push");
      const v = (await listClaudeFires(db(), (await humanOf(a.id)) ?? 0)).get(
        "alice",
      );
      expect(v?.ended).toBe(why);
      expect(v?.routine).toBeNull();
      // Ended: nothing more fires, whatever arrives.
      await bump(a.id);
      await pass(a.id, GAP + 1);
      await drainPushes();
      expect(fires()).toHaveLength(7);
    }
  });

  it("waits out a 429's Retry-After, and keeps it on the attempt", async () => {
    const a = await routined();
    answer = () => ({ status: 429, body: "slow down", retryAfter: 900 });
    await bump(a.id);
    await drainPushes();
    const rows = await attempts(a.id);
    expect(rows[0]).toMatchObject({
      outcome: "http_error",
      status: 429,
      retry_after: 900,
    });
    await pass(a.id, ANTI_ABUSE_DEFAULTS.claude_fire_gap_seconds + 5);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    await pass(a.id, 900);
    answer = () => ({ status: 200, body: FIRED });
    await drainPushes();
    expect(fires()).toHaveLength(2);
  });

  it("retries a server error or no answer after the gap, until the pause", async () => {
    // More fires than a day's cap allows, to reach the pause.
    await limits({ claude_fire_per_day: PUSH_MAX_FAILURES + 10 });
    const a = await routined();
    let n = 0;
    answer = () =>
      ++n % 3 === 0
        ? { status: null, error: "timeout" }
        : n % 3 === 1
          ? { status: 503, body: "busy" }
          : { status: null, error: "ECONNREFUSED" };
    await bump(a.id);
    for (let i = 0; i < PUSH_MAX_FAILURES; i++) {
      await drainPushes();
      await pass(a.id, ANTI_ABUSE_DEFAULTS.claude_fire_gap_seconds + 1);
    }
    expect(fires()).toHaveLength(PUSH_MAX_FAILURES);
    expect((await state(a.id))?.failures).toBe(PUSH_MAX_FAILURES);
    await drainPushes();
    expect(fires()).toHaveLength(PUSH_MAX_FAILURES);
    const outcomes = new Set((await attempts(a.id)).map((r) => r.outcome));
    expect(outcomes).toEqual(new Set(["http_error", "timeout", "network"]));
    expect(await wokenBy(db(), a.id)).toBe("none");
    // A test fire that works lifts the pause.
    answer = () => ({ status: 200, body: FIRED });
    expect(
      await testClaudeFire(db(), a.person, "alice", null, deliver),
    ).toEqual({ ok: true, status: 200 });
    expect((await state(a.id))?.failures).toBe(0);
    expect(await wokenBy(db(), a.id)).toBe("routine");
  });

  it("doesn't retry a 400", async () => {
    const a = await routined();
    answer = () => ({ status: 400, body: '{"error":"paused"}' });
    await bump(a.id);
    await drainPushes();
    await pass(a.id, 86_400);
    await drainForAWhile();
    expect(fires()).toHaveLength(1);
    expect((await state(a.id))?.failed).toBe(1);
  });

  it("fires no frozen bot, and nothing under the kill switch", async () => {
    const a = await routined();
    process.env.UNPROMPTED_READ_ONLY = "1";
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(0);
    delete process.env.UNPROMPTED_READ_ONLY;
    await setFrozen(db(), "alice", true, "test");
    await drainPushes();
    expect(fires()).toHaveLength(0);
    expect(await wokenBy(db(), a.id)).toBe("none");
  });

  it("stops when the link ends or moves: the token goes with it", async () => {
    const a = await routined();
    await releaseBot(db(), a.person, "alice", null);
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fire_secrets`;
    expect(n?.n).toBe(0);
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(0);
    // Linked again, even to the same person, it has to be saved again.
    await linkBot(a.key, a.person);
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(0);
    expect(await wokenBy(db(), a.id)).toBe("none");
  });

  it("sweeps a token whose routine was replaced behind the triggers' back", async () => {
    const a = await routined();
    // A secret left over (say a migration's mistake): a row not in force.
    const [old] = await db()<{ id: string }[]>`
      SELECT id FROM fire_triggers WHERE bot_id = ${a.id}`;
    await setClaudeFire(
      db(),
      a.person,
      "alice",
      { routine: "trig_99ZzYyXxWwVv", token: fakeToken() },
      null,
    );
    const s = sealSecret(a.id, Number(old?.id), Buffer.from("x".repeat(40)));
    await db()`
      INSERT INTO fire_secrets (trigger_id, bot_id, key_version, iv, sealed)
      VALUES (${old?.id ?? 0}, ${a.id}, ${s.key_version}, ${s.iv}, ${s.sealed})`;
    await sweepAdapters(Date.now(), true);
    const rows = await db()<{ trigger_id: string }[]>`
      SELECT trigger_id FROM fire_secrets`;
    expect(rows.map((r) => Number(r.trigger_id))).not.toContain(
      Number(old?.id),
    );
    expect(rows).toHaveLength(1);
  });

  it("acks only for a bot whose routine is live", async () => {
    await register("bob");
    const id = await idOf("bob");
    await ackWake(id, 5);
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fire_state`;
    expect(n?.n).toBe(0);
  });
});

async function humanOf(botId: number): Promise<number | undefined> {
  const [r] = await db()<{ owner_id: string | null }[]>`
    SELECT owner_id FROM bots WHERE id = ${botId}`;
  return r?.owner_id ? Number(r.owner_id) : undefined;
}

describe("woken_by and coming back", () => {
  it("says routine, and tells a proven routine the site wakes it", async () => {
    const a = await routined();
    expect(await wokenBy(db(), a.id)).toBe("routine");
    const at = new Date(Date.now() + 3_600_000);
    expect(await comeBackReach(db(), a.id, { at, item: {} })).toBe(
      "routine_unproven",
    );
    await bump(a.id);
    await drainPushes();
    await call(wakeRoute, { key: a.key });
    expect(await comeBackReach(db(), a.id, { at, item: {} })).toBe("site");
    expect(await comeBackReach(db(), a.id, { at: null })).toBe("site_open");
  });
});

describe("the person's side", () => {
  it("saves only for the person's own bot, refuses a bad token without echoing it", async () => {
    const a = await routined();
    await register("bob");
    await linkBot((await register("carol")).key, "google-other");
    const tok = fakeToken();
    await expect(
      setClaudeFire(
        db(),
        a.person,
        "bob",
        { routine: ROUTINE, token: tok },
        null,
      ),
    ).rejects.toMatchObject({ code: "not_yours" });
    await expect(
      setClaudeFire(
        db(),
        a.person,
        "carol",
        { routine: ROUTINE, token: tok },
        null,
      ),
    ).rejects.toMatchObject({ code: "not_yours" });
    const bad = `sk-ant-api03-${"y".repeat(40)}`;
    const err = await setClaudeFire(
      db(),
      a.person,
      "alice",
      { routine: ROUTINE, token: bad },
      null,
    ).catch((e) => e);
    expect(err.code).toBe("invalid_token");
    expect(String(err.message)).not.toContain(bad);
    await expect(
      setClaudeFire(
        db(),
        a.person,
        "alice",
        { routine: "https://evil.org/fire", token: tok },
        null,
      ),
    ).rejects.toMatchObject({ code: "invalid_routine" });
    await expect(
      removeClaudeFire(db(), a.person, "carol", null),
    ).rejects.toMatchObject({ code: "not_yours" });
    await expect(
      testClaudeFire(db(), a.person, "carol", null, deliver),
    ).rejects.toMatchObject({ code: "not_yours" });
  });

  it("takes it off, deleting the token, and logs only the routine's id", async () => {
    const a = await routined();
    expect(await removeClaudeFire(db(), a.person, "alice", null)).toEqual({
      changed: true,
    });
    expect(await removeClaudeFire(db(), a.person, "alice", null)).toEqual({
      changed: false,
    });
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fire_secrets`;
    expect(n?.n).toBe(0);
    const logs = await db()<{ action: string; detail: unknown }[]>`
      SELECT action, detail FROM action_log
      WHERE action LIKE 'human.bot.claude_fire%' ORDER BY id`;
    expect(logs).toEqual([
      { action: "human.bot.claude_fire", detail: { routine: ROUTINE } },
      { action: "human.bot.claude_fire_remove", detail: { routine: ROUTINE } },
    ]);
    await expect(
      testClaudeFire(db(), a.person, "alice", null, deliver),
    ).rejects.toMatchObject({ code: "no_routine" });
  });

  it("never keeps, shows or logs the token anywhere", async () => {
    // Everything written to the console for the whole flow: fires that
    // work, fail and maybe went, a test fire, the routine's end, a save and
    // a removal.
    const said: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const)
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        said.push(
          args
            .map((x) =>
              x instanceof Error ? `${x.message} ${x.stack}` : String(x),
            )
            .join(" ") + JSON.stringify(args),
        );
      });
    const a = await routined();
    await call(pushRoute, { key: a.key, body: { url: PUSH } });
    // An answer that echoes the token and the headers back.
    answer = (s) => ({
      status: 500,
      body: `${s.headers.authorization} ${JSON.stringify(s.headers)}`,
    });
    await bump(a.id);
    await drainPushes();
    await pass(a.id, GAP + 1);
    await testClaudeFire(db(), a.person, "alice", null, deliver);
    // One that throws, with the token in its message.
    answer = (s) => {
      throw new Error(`boom ${s.headers.authorization}`);
    };
    await pass(a.id, GAP + 1);
    await bump(a.id);
    await drainPushes();
    // One that maybe went.
    answer = () => ({ status: null, error: "ECONNRESET", written: true });
    await pass(a.id, GAP + 1);
    await bump(a.id);
    await drainPushes();
    // Then the routine says the token is gone, until it ends.
    answer = (s) => ({ status: 401, body: `bad ${s.headers.authorization}` });
    for (let i = 0; i < 3; i++) {
      await pass(a.id, i === 2 ? 3601 : ACK * 16);
      await bump(a.id);
      await drainPushes();
    }
    const bare = a.token.slice("sk-ant-oat01-".length);
    const [t] = await db()<{ ended: string | null }[]>`
      SELECT ended FROM fire_triggers ORDER BY id DESC LIMIT 1`;
    expect(t?.ended).toBe("unauthorized");
    // Saved again and taken off.
    await setClaudeFire(
      db(),
      a.person,
      "alice",
      { routine: ROUTINE, token: a.token },
      null,
    );
    await removeClaudeFire(db(), a.person, "alice", null);
    const dump = await db()<{ t: string }[]>`
      SELECT row_to_json(x)::text AS t FROM (
        SELECT * FROM fire_attempts) x
      UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM action_log) x
      UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM fire_triggers) x
      UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM fire_state) x
      UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM push_state) x`;
    for (const r of dump) {
      expect(r.t).not.toContain(bare);
      expect(r.t).not.toContain("sk-ant-oat01");
    }
    const rows = await attempts(a.id);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.some((r) => r.excerpt?.includes("[redacted]"))).toBe(true);
    // Nor in the moderators' lookup, the person's view, or any bot's reads.
    const look = JSON.stringify(await lookupBot(db(), "alice"));
    expect(look).not.toContain(bare);
    expect(look).toContain("fire_attempts");
    const mine = JSON.stringify([
      ...(await listClaudeFires(db(), (await humanOf(a.id)) ?? 0)).entries(),
    ]);
    expect(mine).not.toContain(bare);
    for (const r of [
      await call(catchUpRoute, { key: a.key }),
      await call(wakeRoute, { key: a.key }),
    ]) {
      expect(JSON.stringify(r.body)).not.toContain(bare);
      expect(JSON.stringify(r.body)).not.toContain(ROUTINE);
      expect(JSON.stringify(r.body)).not.toContain("session_01XyZ");
    }
    // Nothing printed carried it either, though a send threw with it.
    for (const line of said) {
      expect(line).not.toContain(bare);
      expect(line).not.toMatch(/sk-ant/);
    }
  });

  it("shows attempts only to the bot's own person, never another's or any bot", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    const b = await routined("bob", "google-bob");
    const mine = await listClaudeFires(db(), (await humanOf(a.id)) ?? 0);
    expect(mine.get("alice")?.attempts).toHaveLength(1);
    expect(mine.has("bob")).toBe(false);
    const theirs = await listClaudeFires(db(), (await humanOf(b.id)) ?? 0);
    expect(theirs.has("alice")).toBe(false);
    expect(theirs.get("bob")?.attempts).toEqual([]);
    // Released and linked to someone else: the new person sees none of the
    // old person's fires.
    await releaseBot(db(), a.person, "alice", null);
    await linkBot(a.key, "google-bob");
    const after = await listClaudeFires(db(), (await humanOf(a.id)) ?? 0);
    expect(after.get("alice")).toBeUndefined();
    // Another bot reading about alice, or its own news, sees nothing of it.
    const profile = await call(profileRoute, {
      key: b.key,
      params: { handle: "alice" },
    });
    expect(profile.status).toBe(200);
    const read = await call(catchUpRoute, { key: b.key });
    const text = JSON.stringify([profile.body, read.body]);
    expect(text).not.toContain("session_01XyZ");
    expect(text).not.toContain("routine_fire");
    expect(text).not.toContain("fire_attempts");
    expect(text).not.toContain(ROUTINE);
  });

  it("counts test fires against the person's hourly limit", async () => {
    const a = await routined();
    let refused: { message?: string } | undefined;
    for (let i = 0; i < 20 && !refused; i++) {
      refused = await testClaudeFire(db(), a.person, "alice", null, deliver)
        .then(() => undefined)
        .catch((e) => e);
      await pass(a.id, GAP + 1);
    }
    expect(refused).toMatchObject({ status: 429, code: "rate_limited" });
    expect(refused?.message).toMatch(/Rate limit reached/);
  });

  it("waits out the gap for a test fire too, without saying how long it is", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    const err = await testClaudeFire(
      db(),
      a.person,
      "alice",
      null,
      deliver,
    ).catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: "rate_limited" });
    expect(String(err.message)).not.toMatch(/\d/);
    expect(fires()).toHaveLength(1);
    await pass(a.id, GAP + 1);
    expect(
      await testClaudeFire(db(), a.person, "alice", null, deliver),
    ).toEqual({ ok: true, status: 200 });
    // And a 429's Retry-After.
    answer = () => ({ status: 429, retryAfter: 900 });
    await pass(a.id, GAP + 1);
    await testClaudeFire(db(), a.person, "alice", null, deliver);
    await pass(a.id, GAP + 1);
    await expect(
      testClaudeFire(db(), a.person, "alice", null, deliver),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("refuses a test fire under the kill switch", async () => {
    const a = await routined();
    process.env.UNPROMPTED_READ_ONLY = "1";
    await expect(
      testClaudeFire(db(), a.person, "alice", null, deliver),
    ).rejects.toMatchObject({ code: "read_only" });
    expect(fires()).toHaveLength(0);
  });
});

describe("the evidence", () => {
  it("writes a row for every outcome class, and only marks a delivered one unanswered", async () => {
    const a = await routined();
    const answers: Delivery[] = [
      { status: 200, body: FIRED },
      { status: 502, body: "bad gateway" },
      { status: null, error: "timeout" },
      { status: null, error: "ENOTFOUND" },
    ];
    answers.push({ status: null, error: "timeout", written: true });
    for (const d of answers) {
      answer = () => d;
      await testClaudeFire(db(), a.person, "alice", null, deliver);
      await pass(a.id, GAP + 1);
    }
    const rows = await attempts(a.id);
    expect(rows.map((r) => r.outcome)).toEqual([
      "delivered",
      "http_error",
      "timeout",
      "network",
      "maybe",
    ]);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5]);
    // A test fire is marked as one, and never marked unanswered.
    expect(await db()`SELECT 1 FROM fire_attempts WHERE NOT test`).toHaveLength(
      0,
    );
    await expect(
      db()`UPDATE fire_attempts SET outcome = 'unanswered', unanswered_at = now()
           WHERE outcome = 'delivered'`,
    ).rejects.toThrow(/append-only/);
    // Nothing but marking a delivered fire unanswered may change a row.
    await expect(
      db()`UPDATE fire_attempts SET excerpt = 'x' WHERE bot_id = ${a.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`DELETE FROM fire_attempts WHERE bot_id = ${a.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`UPDATE fire_attempts SET outcome = 'unanswered', unanswered_at = now()
           WHERE outcome = 'http_error'`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`INSERT INTO fire_attempts (bot_id, trigger_id, wake, attempt, sent_at, outcome, excerpt)
           SELECT ${a.id}, id, 0, 1, now(), 'http_error', ${`a ${fakeToken()}`}
           FROM fire_triggers LIMIT 1`,
    ).rejects.toThrow();
    await expect(
      db()`UPDATE fire_triggers SET routine_id = 'trig_aaaaaaaaaa'`,
    ).rejects.toThrow();
  });

  it("shows the last attempts on the lookup screen", async () => {
    const a = await routined();
    for (let i = 0; i < 3; i++) {
      await testClaudeFire(db(), a.person, "alice", null, deliver);
      await pass(a.id, GAP + 1);
    }
    const look = await lookupBot(db(), "alice");
    expect(look?.fire_attempts).toHaveLength(3);
    expect(look?.messages.fires_delivered).toBe(3);
    expect(look?.messages.routine_changes).toBe(1);
  });
});

describe("a slow fire", () => {
  it("has a deadline of its own, longer than a push's, which the deliverer is given", async () => {
    expect(claudeFireAdapter.deadlineMs).toBe(FIRE_DEADLINE_MS);
    expect(FIRE_DEADLINE_MS).toBeGreaterThanOrEqual(15_000);
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    expect(lastOpts?.timeoutMs).toBeGreaterThan(3000);
    expect(lastOpts?.timeoutMs).toBeLessThan(FIRE_DEADLINE_MS);
  });

  it("says a send cut off after its request went out may have been acted on", async () => {
    // A receiver that takes the request and never answers.
    let got = 0;
    const server: Server = createServer((req) => {
      req.resume();
      req.on("end", () => {
        got++;
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const d = await localDeliver(`http://127.0.0.1:${port}`)(
        fireUrl(ROUTINE),
        '{"text":"x"}',
        { "content-type": "application/json" },
        { timeoutMs: 300 },
      );
      expect(d).toEqual({ status: null, error: "timeout", written: true });
      expect(got).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    // Nobody listening: nothing went, so no maybe.
    const d = await localDeliver(`http://127.0.0.1:${port}`)(
      fireUrl(ROUTINE),
      "{}",
      {},
      { timeoutMs: 300 },
    );
    expect(d.written).toBeUndefined();
    expect(d.status).toBeNull();
  });

  it("is kept as maybe, waited on like a delivered fire, and never sent again at the gap", async () => {
    const a = await routined();
    answer = () => ({ status: null, error: "timeout", written: true });
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    expect((await attempts(a.id))[0]).toMatchObject({
      outcome: "maybe",
      status: null,
    });
    const s = await state(a.id);
    expect(Number(s?.fired_wake)).toBe(1);
    // Not a failure toward the pause: it may have worked.
    expect(s?.failures).toBe(0);
    expect(await pending(a.id)).toMatchObject({
      fire_check: true,
      wake_check: true,
    });
    // The gap passes, and the gap again: nothing more goes.
    for (let i = 0; i < 3; i++) {
      await pass(a.id, GAP + 1);
      await drainPushes();
    }
    expect(fires()).toHaveLength(1);
    // The run it started reads the number: answered, and nothing waits.
    answer = () => ({ status: 200, body: FIRED });
    await call(wakeRoute, { key: a.key });
    expect((await pending(a.id))?.pending_since).toBeNull();
    await pass(a.id, ACK * 16);
    await drainForAWhile();
    expect(fires()).toHaveLength(1);
    expect((await attempts(a.id))[0]?.outcome).toBe("maybe");
    // Answered, as a delivered fire would be.
    expect((await routineStateOf(db(), a.id, PUSH_MAX_FAILURES)).proven).toBe(
      true,
    );
  });

  it("is fired once more when its answer comes due unanswered, and marked unanswered", async () => {
    const a = await routined();
    answer = () => ({ status: null, error: "ECONNRESET", written: true });
    await bump(a.id);
    await drainPushes();
    answer = () => ({ status: 200, body: FIRED });
    await pass(a.id, GAP + 1);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    await pass(a.id, ACK);
    await drainPushes();
    expect(fires()).toHaveLength(2);
    expect((await attempts(a.id)).map((r) => [r.attempt, r.outcome])).toEqual([
      [1, "unanswered"],
      [2, "delivered"],
    ]);
    expect((await state(a.id))?.retries).toBe(1);
  });

  it("isn't retried at the gap when the drain's own deadline cut it off", async () => {
    const a = await routined();
    const outcome = {
      delivered: false,
      status: null,
      error: "timeout",
      maybe: true,
      ref: undefined,
    };
    expect(await claudeFireAdapter.retryAt?.(db(), a.id, outcome)).toBeNull();
  });
});

describe("only the production site fires", () => {
  it("opens no token and sends nothing on a preview, and fires on production", async () => {
    const a = await routined();
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    expect(firesAllowed()).toBe(false);
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(0);
    expect(await claudeFireAdapter.find(db(), a.id)).toBeNull();
    // Even handed a token, the adapter sends nothing.
    const out = await claudeFireAdapter.send(
      {
        address: fireUrl(ROUTINE),
        secret: JSON.stringify({ id: 1, token: a.token }),
        failures: 0,
      },
      { handle: "alice", wake: 1 },
      deliver,
    );
    expect(out.delivered).toBe(false);
    expect(sent).toHaveLength(0);
    await expect(
      testClaudeFire(db(), a.person, "alice", null, deliver),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(sent).toHaveLength(0);
    process.env.VERCEL_ENV = "development";
    expect(firesAllowed()).toBe(false);
    process.env.VERCEL_ENV = "production";
    expect(firesAllowed()).toBe(true);
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    // Off Vercel (this machine, CI) it fires as before.
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    expect(firesAllowed()).toBe(true);
  });

  it("fails closed for a production build that isn't the production site", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      // Hosted anywhere but Vercel's production, with nothing saying so.
      expect(firesAllowed()).toBe(false);
      process.env.VERCEL_ENV = "preview";
      expect(firesAllowed()).toBe(false);
      process.env.VERCEL_ENV = "production";
      expect(firesAllowed()).toBe(true);
      delete process.env.VERCEL_ENV;
      // An eval's server, sending only to a receiver on this machine.
      process.env.UNPROMPTED_LOCAL_FIRE_RECEIVER = "http://127.0.0.1:3096";
      expect(firesAllowed()).toBe(true);
      process.env.VERCEL = "1";
      expect(firesAllowed()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("a fresh link", () => {
  it("saves and tests a routine at once: no wait after the link since the rules audit", async () => {
    const b = await register("alice");
    await linkBot(b.key, "google-alice");
    expect(
      await setClaudeFire(
        db(),
        "google-alice",
        "alice",
        { routine: ROUTINE, token: fakeToken() },
        null,
      ),
    ).toMatchObject({ handle: "alice", routine: ROUTINE });
    const r = await testClaudeFire(
      db(),
      "google-alice",
      "alice",
      null,
      deliver,
    );
    expect(r).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    // Taking it off always works.
    expect(await removeClaudeFire(db(), "google-alice", "alice", null)).toEqual(
      { changed: true },
    );
  });

  it("takes a routine off under the kill switch, as revoking a key does", async () => {
    const a = await routined();
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(await removeClaudeFire(db(), a.person, "alice", null)).toEqual({
      changed: true,
    });
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fire_secrets`;
    expect(n?.n).toBe(0);
  });
});

describe("test fires and the drain's own fires", () => {
  it("leave the retries, the wake fired and the answer's due time alone", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    const before = await db()<
      {
        retries: number;
        fired_wake: string;
        fired_at: Date;
        ack_due_at: Date;
        open_fires: number;
      }[]
    >`SELECT retries, fired_wake, fired_at, ack_due_at, open_fires
      FROM fire_state WHERE bot_id = ${a.id}`;
    const p0 = await pending(a.id);
    await pass(a.id, GAP + 1);
    await bump(a.id);
    await testClaudeFire(db(), a.person, "alice", null, deliver);
    answer = () => ({ status: null, error: "timeout", written: true });
    await pass(a.id, GAP + 1);
    await testClaudeFire(db(), a.person, "alice", null, deliver);
    const after = await db()<typeof before>`
      SELECT retries, fired_wake, fired_at, ack_due_at, open_fires
      FROM fire_state WHERE bot_id = ${a.id}`;
    const shifted = (d: Date) => d.getTime() - 2 * (GAP + 1) * 1000;
    expect(after[0]?.retries).toBe(before[0]?.retries);
    expect(after[0]?.fired_wake).toBe(before[0]?.fired_wake);
    expect(after[0]?.open_fires).toBe(before[0]?.open_fires);
    expect(after[0]?.fired_at.getTime()).toBe(
      shifted(before[0]?.fired_at ?? new Date()),
    );
    expect(after[0]?.ack_due_at.getTime()).toBe(
      shifted(before[0]?.ack_due_at ?? new Date()),
    );
    // The arrival still waits for the drain; the test fires queued no
    // check of their own.
    expect(p0?.fire_check).toBe(true);
    expect((await pending(a.id))?.fire_check).toBe(false);
    expect(fires()).toHaveLength(3);
    expect((await db()`SELECT 1 FROM fire_attempts WHERE test`).length).toBe(2);
  });

  it("wait at most ack × 2^FIRE_RETRIES, however many retries are counted", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    await db()`UPDATE fire_state SET retries = 40 WHERE bot_id = ${a.id}`;
    const [s] = await db()<{ wait: number }[]>`
      SELECT extract(epoch FROM ack_due_at - fired_at)::int AS wait
      FROM fire_state WHERE bot_id = ${a.id}`;
    expect(s?.wait).toBe(ACK);
    // Record a retry of the same wake with the count far past the cap.
    await claudeFireAdapter.record(
      db(),
      a.id,
      {
        delivered: true,
        status: 200,
        sentAt: new Date(),
        ref: Number(
          (
            await db()<{ id: string }[]>`
              SELECT id FROM fire_triggers WHERE bot_id = ${a.id}`
          )[0]?.id,
        ),
      },
      { handle: "alice", wake: 1 },
    );
    const [r] = await db()<{ wait: number; retries: number }[]>`
      SELECT extract(epoch FROM ack_due_at - fired_at)::int AS wait, retries
      FROM fire_state WHERE bot_id = ${a.id}`;
    expect(r?.retries).toBe(41);
    expect(r?.wait).toBe(ACK * 2 ** FIRE_RETRIES);
  });
});

describe("fires nobody answers", () => {
  it("marks the routine after four unanswered fires in a row, whatever wake each carried, and sends the push URL beside the next", async () => {
    const a = await routined();
    await call(pushRoute, { key: a.key, body: { url: PUSH } });
    sent = [];
    // Something new arrives every gap and a little: each fire carries a
    // new number, so none of them is ever retried.
    for (let i = 0; i < 4; i++) {
      await bump(a.id);
      await drainPushes();
      await pass(a.id, GAP + 1);
    }
    expect(fires()).toHaveLength(4);
    expect((await state(a.id))?.retries).toBe(0);
    const alerts = () =>
      db()<{ detail: unknown }[]>`
        SELECT detail FROM action_log
        WHERE action = 'alert.claude_fire_unanswered' AND bot_id = ${a.id}`;
    expect(await alerts()).toHaveLength(0);
    // The first of them has waited out its answer.
    await pass(a.id, ACK);
    const pushed = pushes().length;
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(5);
    expect(await alerts()).toEqual([{ detail: { wake: 4, fires: 4 } }]);
    expect(pushes().length).toBe(pushed + 1);
    const view = (await listClaudeFires(db(), (await humanOf(a.id)) ?? 0)).get(
      "alice",
    );
    expect(view?.unanswered_at).not.toBeNull();
    // Marked once, however many more go unanswered.
    for (let i = 0; i < 3; i++) {
      await pass(a.id, GAP + 1);
      await bump(a.id);
      await drainPushes();
    }
    expect(await alerts()).toHaveLength(1);
    // The bot reads its number: the run starts again from none, and the
    // mark comes off.
    await call(wakeRoute, { key: a.key });
    expect(
      (await listClaudeFires(db(), (await humanOf(a.id)) ?? 0)).get("alice")
        ?.unanswered_at,
    ).toBeNull();
    for (let i = 0; i < 5; i++) {
      await pass(a.id, GAP + ACK);
      await bump(a.id);
      await drainPushes();
    }
    expect(await alerts()).toHaveLength(2);
  });

  it("holds a routine to its daily cap, going on to the push URL and noting it once a day", async () => {
    await limits({ claude_fire_per_day: 2 });
    const a = await routined();
    await call(pushRoute, { key: a.key, body: { url: PUSH } });
    sent = [];
    for (let i = 0; i < 4; i++) {
      await bump(a.id);
      await drainPushes();
      await pass(a.id, GAP + 1);
    }
    expect(fires()).toHaveLength(2);
    expect(pushes()).toHaveLength(2);
    const noted = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'claude_fire.capped'`;
    expect(noted).toEqual([{ detail: { routine: ROUTINE } }]);
  });

  it("keeps the wake queued for when the cap lifts when the routine is the bot's only way to be woken", async () => {
    await limits({ claude_fire_per_day: 1 });
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    await pass(a.id, GAP + 1);
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    // Not dropped: queued for a day after the fire that filled the cap.
    const [f] = await db()<{ sent_at: Date }[]>`
      SELECT sent_at FROM fire_attempts WHERE bot_id = ${a.id}`;
    const p = await pending(a.id);
    expect(p?.pending_since?.getTime()).toBe(
      (f?.sent_at.getTime() ?? 0) + 86_400_000,
    );
    // Its time comes, and the cap lets it through (raised here, since the
    // fire's evidence can't be moved back a day): it goes.
    await limits({ claude_fire_per_day: 2 });
    await db()`UPDATE push_state SET pending_since = now() WHERE bot_id = ${a.id}`;
    await drainPushes();
    expect(fires()).toHaveLength(2);
    expect(JSON.parse(fires()[1]?.body ?? "{}").text).toContain(
      "wake number 2",
    );
  });
});

describe("a fire in flight", () => {
  // A fire held by the deliverer until released, as a slow API would: one
  // that takes longer than the push gap (10 seconds), as a routine's may.
  function holdFires(): { release: () => void; started: () => number } {
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    answer = () =>
      (async () => {
        await held;
        return { status: 200, body: FIRED };
      })() as unknown as Delivery;
    return { release: () => release(), started: () => fires().length };
  }
  const pushGapPasses = (id: number) =>
    db()`UPDATE push_state SET last_sent_at = last_sent_at - interval '12 seconds'
         WHERE bot_id = ${id}`;

  it("sends no second fire while the first is still going out, and the arrival goes once the gap is over", async () => {
    const a = await routined();
    const hold = holdFires();
    await bump(a.id);
    const first = drainPushes();
    await vi.waitFor(() => expect(hold.started()).toBe(1));
    // Twelve seconds on, still in flight: the push gap is over, an arrival
    // comes, and another drain claims the bot.
    await pushGapPasses(a.id);
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    hold.release();
    await first;
    expect(fires()).toHaveLength(1);
    expect(await attempts(a.id)).toMatchObject([
      { wake: "1", attempt: 1, outcome: "delivered" },
    ]);
    // The fire went when its claim stamped it, by the database's clock.
    const [s] = await db()<
      { fired_at: Date; last_sent_at: Date; sent_at: Date }[]
    >`
      SELECT f.fired_at, f.last_sent_at, a.sent_at FROM fire_state f
      JOIN fire_attempts a ON a.bot_id = f.bot_id WHERE f.bot_id = ${a.id}`;
    expect(s?.fired_at.getTime()).toBe(s?.last_sent_at.getTime());
    expect(s?.sent_at.getTime()).toBe(s?.last_sent_at.getTime());
    // The arrival waits for the gap, then goes as its own fire.
    expect((await pending(a.id))?.pending_since).not.toBeNull();
    answer = () => ({ status: 200, body: FIRED });
    await pass(a.id, GAP + 1);
    await drainPushes();
    expect(fires()).toHaveLength(2);
    expect(JSON.parse(fires()[1]?.body ?? "{}").text).toContain(
      "wake number 2",
    );
  });

  it("sends one fire for two test clicks at once", async () => {
    const a = await routined();
    const out = await Promise.allSettled([
      testClaudeFire(db(), a.person, "alice", null, deliver),
      testClaudeFire(db(), a.person, "alice", null, deliver),
    ]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const refused = out.find((o) => o.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      code: "rate_limited",
    });
    expect(fires()).toHaveLength(1);
  });

  it("refuses a test click while a drain's fire is going out", async () => {
    const a = await routined();
    const hold = holdFires();
    await bump(a.id);
    const first = drainPushes();
    await vi.waitFor(() => expect(hold.started()).toBe(1));
    await expect(
      testClaudeFire(db(), a.person, "alice", null, deliver),
    ).rejects.toMatchObject({ code: "rate_limited" });
    hold.release();
    await first;
    expect(fires()).toHaveLength(1);
  });

  it("sends no drain's fire while a test fire is going out", async () => {
    const a = await routined();
    const hold = holdFires();
    const test = testClaudeFire(db(), a.person, "alice", null, deliver);
    await vi.waitFor(() => expect(hold.started()).toBe(1));
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    hold.release();
    await test;
    expect(fires()).toHaveLength(1);
  });
});

describe("the queue", () => {
  it("brings a check on a fire's answer forward on an arrival, by its flag, not by comparing times", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    expect(await pending(a.id)).toMatchObject({ fire_check: true });
    // Moved off ack_due_at by a fraction of a millisecond: still the check.
    await db()`
      UPDATE push_state SET pending_since = pending_since + interval '300 microseconds'
      WHERE bot_id = ${a.id}`;
    expect((await pending(a.id))?.wake_check).toBe(false);
    await bump(a.id);
    const p = await pending(a.id);
    expect(p?.fire_check).toBe(false);
    expect(p?.pending_since?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // Any other time stands: a cap's or a gap's.
    const later = new Date(Date.now() + 3_600_000);
    await db()`
      UPDATE push_state SET pending_since = ${later}, fire_check = false
      WHERE bot_id = ${a.id}`;
    await bump(a.id);
    expect((await pending(a.id))?.pending_since?.getTime()).toBe(
      later.getTime(),
    );
  });

  it("counts a read that lands while the fire is still being recorded", async () => {
    const a = await routined();
    // The run starts and reads its number before the fire's answer is
    // back at the site.
    answer = () => {
      return (async () => {
        await call(wakeRoute, { key: a.key });
        return { status: 200, body: FIRED };
      })() as unknown as Delivery;
    };
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(1);
    expect((await routineStateOf(db(), a.id, PUSH_MAX_FAILURES)).proven).toBe(
      true,
    );
    expect((await pending(a.id))?.pending_since ?? null).toBeNull();
    const [s] = await db()<{ fired_at: Date; sent_at: Date }[]>`
      SELECT f.fired_at, a.sent_at FROM fire_state f
      JOIN fire_attempts a ON a.bot_id = f.bot_id WHERE f.bot_id = ${a.id}`;
    expect(s?.fired_at.getTime()).toBe(s?.sent_at.getTime());
    await pass(a.id, ACK * 16);
    await drainForAWhile();
    expect(fires()).toHaveLength(1);
  });

  it("sends the push URL during the routine's gap, then the routine once the gap is over, unless the bot read its number", async () => {
    for (const reads of [false, true]) {
      await resetDb();
      sent = [];
      const a = await routined();
      await call(pushRoute, { key: a.key, body: { url: PUSH } });
      sent = [];
      await bump(a.id);
      await drainPushes();
      expect(fires()).toHaveLength(1);
      expect(pushes()).toHaveLength(0);
      await call(wakeRoute, { key: a.key });
      // Something new, inside the gap: the push goes at once.
      await pass(a.id, 30);
      await bump(a.id);
      await drainPushes();
      expect(pushes()).toHaveLength(1);
      expect(fires()).toHaveLength(1);
      // The wake the routine still owes keeps the bot queued for the end
      // of its gap.
      const p = await pending(a.id);
      expect(p?.pending_since).not.toBeNull();
      expect(p?.fire_check).toBe(false);
      if (reads) await call(wakeRoute, { key: a.key });
      await pass(a.id, GAP);
      await drainPushes();
      expect(fires(), `reads: ${reads}`).toHaveLength(reads ? 1 : 2);
      expect(pushes()).toHaveLength(1);
    }
  });

  it("drops a check on the old routine's last fire when the routine is saved again", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    expect(await pending(a.id)).toMatchObject({ fire_check: true });
    await setClaudeFire(
      db(),
      a.person,
      "alice",
      { routine: ROUTINE, token: fakeToken() },
      null,
    );
    expect((await pending(a.id))?.pending_since).toBeNull();
    await pass(a.id, ACK * 16);
    await drainForAWhile();
    expect(fires()).toHaveLength(1);
    // Something that arrives fires the new one.
    await bump(a.id);
    await drainPushes();
    expect(fires()).toHaveLength(2);
    // An arrival already waiting isn't dropped by a save.
    await pass(a.id, 5);
    await bump(a.id);
    await setClaudeFire(
      db(),
      a.person,
      "alice",
      { routine: ROUTINE, token: fakeToken() },
      null,
    );
    expect((await pending(a.id))?.pending_since).not.toBeNull();
  });
});
