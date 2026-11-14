import { randomBytes } from "node:crypto";
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
  FIRE_RETRIES,
  fireExcerpt,
  fireText,
  fireUrl,
  planFire,
  routineIdOf,
} from "@/lib/wake-adapters/claude-fire";
import { openSecret, sealSecret } from "@/lib/wake-secrets";
import { comeBackReach, wokenBy } from "@/lib/woken";
import { call, linkBot, register, resetDb } from "./helpers";

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

const deliver: Deliver = async (url, body, headers) => {
  const s = { url, body, headers };
  sent.push(s);
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
  const token = fakeToken();
  await setClaudeFire(db(), person, handle, { routine: ROUTINE, token }, null);
  return { ...b, id: await idOf(handle), token, person };
}

const bump = (id: number) => db()`SELECT bump_wake(${id})`;

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
      seen_at = seen_at - ${d}::interval
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

  it("is answered by catch_up too", async () => {
    const a = await routined();
    await bump(a.id);
    await drainPushes();
    const r = await call(catchUpRoute, { key: a.key });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const st = await routineStateOf(db(), a.id, PUSH_MAX_FAILURES);
    expect(st.proven).toBe(true);
  });

  it("fires an unanswered wake again, waiting longer each time, then marks it once and falls through", async () => {
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
    }
    expect(pushes()).toHaveLength(0);
    await pass(a.id, ack * 2 ** FIRE_RETRIES + 1);
    await drainPushes();
    // No fifth fire: marked, and the push URL takes it.
    expect(fires()).toHaveLength(FIRE_RETRIES + 1);
    expect(pushes()).toHaveLength(1);
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

  it("ends the routine on a 401 or 404 and falls through to the push URL", async () => {
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
      await bump(a.id);
      await drainPushes();
      expect(fires()).toHaveLength(1);
      expect(pushes()).toHaveLength(1);
      const [t] = await db()<{ ended: string | null }[]>`
        SELECT ended FROM fire_triggers WHERE bot_id = ${a.id}
        ORDER BY id DESC LIMIT 1`;
      expect(t?.ended).toBe(why);
      const [n] = await db()<{ n: number }[]>`
        SELECT count(*)::int AS n FROM fire_secrets WHERE bot_id = ${a.id}`;
      expect(n?.n).toBe(0);
      const logs = await db()<{ detail: unknown }[]>`
        SELECT detail FROM action_log WHERE action = 'claude_fire.ended'`;
      expect(logs).toEqual([{ detail: { routine: ROUTINE, reason: why } }]);
      expect(await wokenBy(db(), a.id)).toBe("push");
      const v = (await listClaudeFires(db(), (await humanOf(a.id)) ?? 0)).get(
        "alice",
      );
      expect(v?.ended).toBe(why);
      expect(v?.routine).toBeNull();
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
    const a = await routined();
    // An answer that echoes the token and the headers back.
    answer = (s) => ({
      status: 500,
      body: `${s.headers.authorization} ${JSON.stringify(s.headers)}`,
    });
    await bump(a.id);
    await drainPushes();
    await testClaudeFire(db(), a.person, "alice", null, deliver);
    const bare = a.token.slice("sk-ant-oat01-".length);
    const dump = await db()<{ t: string }[]>`
      SELECT row_to_json(x)::text AS t FROM (
        SELECT * FROM fire_attempts) x
      UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM action_log) x
      UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM fire_triggers) x
      UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM fire_state) x
      UNION ALL SELECT row_to_json(x)::text FROM (
        SELECT trigger_id, bot_id, encode(sealed, 'escape') AS s FROM fire_secrets) x`;
    for (const r of dump) {
      expect(r.t).not.toContain(bare);
      expect(r.t).not.toContain("sk-ant-oat01");
    }
    const rows = await attempts(a.id);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.excerpt?.includes("[redacted]"))).toBe(true);
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
    let refused: unknown;
    for (let i = 0; i < 20 && !refused; i++)
      refused = await testClaudeFire(db(), a.person, "alice", null, deliver)
        .then(() => undefined)
        .catch((e) => e);
    expect(refused).toMatchObject({ status: 429 });
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
    for (const d of answers) {
      answer = () => d;
      await testClaudeFire(db(), a.person, "alice", null, deliver);
    }
    const rows = await attempts(a.id);
    expect(rows.map((r) => r.outcome)).toEqual([
      "delivered",
      "http_error",
      "timeout",
      "network",
    ]);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3, 4]);
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
    for (let i = 0; i < 3; i++)
      await testClaudeFire(db(), a.person, "alice", null, deliver);
    const look = await lookupBot(db(), "alice");
    expect(look?.fire_attempts).toHaveLength(3);
    expect(look?.messages.fires_delivered).toBe(3);
    expect(look?.messages.routine_changes).toBe(1);
  });
});
