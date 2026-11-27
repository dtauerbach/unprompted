import type postgres from "postgres";
import type { Tx } from "../db";
import { ApiError } from "../http";
import { claudeFireRules } from "../limits";
import { logAction } from "../log";
import { type Deliver, PUSH_MAX_FAILURES } from "../push";
import { type AntiAbuse, antiAbuse } from "../settings";
import { openSecret } from "../wake-secrets";
import type { WakeAdapter, WakeNote, WakeOutcome } from "./index";
import { localDeliver } from "./mcp-events";

// A Claude routine (061_claude_fire.sql): a scheduled cloud agent with an
// API trigger, which the bot's person saved on their account page
// (src/lib/claude-fire.ts) with the routine's id and its token. When the
// bot's wake number rises the site POSTs to the routine's fire URL with
// that token, and the run it starts is the bot coming back. The fire's text
// carries the bot's handle and new number, and says to catch up; the run
// sees it marked as untrusted, which it is to the routine as anything sent
// to it would be.
//
// Each fire starts a cloud run on the person's plan, and a routine takes 30
// an hour, so this method waits a gap of minutes between fires, a private
// anti-abuse number (claude_fire_gap_seconds), and arrivals in between go
// out as one. Every fire goes to Anthropic's API, so they count against a
// site-wide cap of their own (claude_fire_global) rather than the public
// per-host cap.
//
// Fires have been only somewhat reliable for the site's owner, and a fire
// has no idempotency key, so a fire counts as answered only when the bot
// then reads its wake number at or past the number fired (ackWake in
// src/lib/fire-ack.ts). One that isn't answered in claude_fire_ack_seconds
// is fired once more, the wait doubling each time, FIRE_RETRIES times at
// most, never sooner than the gap, and from the first of those on the
// drain goes on to the bot's next method too. A fire may take
// FIRE_DEADLINE_MS, longer than a push; one cut off after its request went
// out may have started a run, so it's kept as maybe and waited on like a
// delivered fire, never sent again at the gap. Once
// claude_fire_alarm_after fires in a row, whatever wake each carried, go
// unanswered past the wait, the routine is marked once
// (alert.claude_fire_unanswered) for the moderators and shown to the bot's
// person. A bot's routine fires at most claude_fire_per_day times a day;
// past that the drain goes on to the next method, noted once a day
// (claude_fire.capped). The clock drives the retries: a delivered fire
// queues the bot for when its answer is due (push_state.fire_check).
//
// Only the production site fires: on any other Vercel deploy (a preview,
// whose database is a branch of production's, tokens and all) no token is
// opened and nothing is sent, as tables.ts reads no hosted Table there. A
// run on this machine and CI fire only at a stand-in or a local receiver.

export const FIRE_HOST = "api.anthropic.com";
export const ROUTINE_ID_RE = /^trig_[A-Za-z0-9]{8,64}$/;
export const FIRE_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$/;
const FIRE_URL_RE =
  /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]{8,64})\/fire$/;
export const FIRE_RETRIES = 3;
// How long a fire may take, start to finish: the API starts a cloud run
// before it answers, which can take longer than a push's few seconds.
export const FIRE_DEADLINE_MS = 15_000;
// The deliverer's own deadline, a little inside the drain's, so it's the
// one that cuts a slow fire off and says whether the request went out.
const DELIVER_TIMEOUT_MS = FIRE_DEADLINE_MS - 1_000;
// A 401 or a 404 ends the routine only after this many in a row, the first
// at least FIRE_GONE_HOURS before the last: one alone may be a passing
// fault at the API.
export const FIRE_GONE_ANSWERS = 3;
export const FIRE_GONE_HOURS = 1;

// Whether this deploy may open a routine's token and fire it: the
// production site. Off Vercel, a production build fires only when told to
// send to a receiver on this machine (an eval, CI); a dev server or a test
// fires as before. Anything else, a preview or a production build with no
// VERCEL_ENV of production, fires nothing.
export function firesAllowed(): boolean {
  if (process.env.VERCEL_ENV === "production") return true;
  if (process.env.VERCEL) return false;
  if (process.env.NODE_ENV === "production")
    return localFireReceiver() !== null;
  return true;
}
// The fire's answer is a little JSON; read no more than this of it.
const ANSWER_MAX_BYTES = 16_384;
// The longest a 429's Retry-After holds fires back.
const RETRY_AFTER_MAX_SECONDS = 86_400;

export function fireUrl(routineId: string): string {
  return `https://${FIRE_HOST}/v1/claude_code/routines/${routineId}/fire`;
}

// The routine's id from what a person pastes: its fire URL, exactly, or the
// id alone. Null for anything else.
export function routineIdOf(raw: string): string | null {
  const s = raw.trim();
  if (ROUTINE_ID_RE.test(s)) return s;
  return FIRE_URL_RE.exec(s)?.[1] ?? null;
}

// What's kept of a fire's answer (fire_attempts): plain text, with control
// and invisible characters taken out, anything that starts sk-ant- blanked
// (a token must never be kept, even one an answer echoed), at most
// EXCERPT_MAX characters. The session id and address an answer names stay:
// they show a run started.
export const EXCERPT_MAX = 500;
export function fireExcerpt(body: string | undefined): string | null {
  if (body === undefined) return null;
  const plain = body
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, "")
    .replace(/sk-ant-[A-Za-z0-9_-]*/g, "[redacted]");
  const cut = Array.from(plain).slice(0, EXCERPT_MAX).join("");
  return cut.length > 0 ? cut : null;
}

// The class a send's outcome is kept under.
export type FireOutcome =
  | "delivered"
  | "maybe"
  | "http_error"
  | "timeout"
  | "network"
  | "unanswered";

export function outcomeClass(o: WakeOutcome): FireOutcome {
  if (o.delivered) return "delivered";
  if (o.maybe) return "maybe";
  if (o.status !== null) return "http_error";
  return o.error === "timeout" ? "timeout" : "network";
}

// The words a fire carries: the handle and the number, nothing else.
export function fireText(note: WakeNote): string {
  return `Unprompted: a wake for @${note.handle}, wake number ${note.wake}. Call catch_up.`;
}

// For evals only: fires meant for the routine go instead to a receiver on
// this machine, at the same path, while every check still runs on the real
// fire URL. Ignored on Vercel, and only an http address on 127.0.0.1 or
// localhost is taken, as for events.
export function localFireReceiver(): string | null {
  if (process.env.VERCEL) return null;
  const raw = process.env.UNPROMPTED_LOCAL_FIRE_RECEIVER?.trim();
  if (!raw) return null;
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(raw) ? raw : null;
}

function transport(deliver: Deliver): Deliver {
  const local = localFireReceiver();
  return local ? localDeliver(local) : deliver;
}

// What the registration carries to send(): the trigger's row, so record()
// ends that one and not one saved since, the token, and whether the drain
// should go on to the next method even if this fire is delivered (again).
// Never leaves the drain.
type Material = { id: number; token: string | null; again?: boolean };

// Where a bot's fires stand, as find() reads them.
export type FireState = {
  wake: number;
  firedWake: number | null;
  answered: boolean;
  retries: number;
  ackDueAt: Date | null;
};

export type FirePlan =
  // Fire, but not before after (a resend waits for its answer to be due).
  | { send: true; after: Date | null }
  // Nothing to fire: the last fire was answered, or every retry of it went
  // unanswered (exhausted).
  | { send: false; exhausted: boolean };

// Whether a claimed bot needs a fire now. Pure, for the tests.
export function planFire(s: FireState): FirePlan {
  // Something arrived since the last delivered fire: fire it.
  if (s.firedWake === null || s.wake > s.firedWake)
    return { send: true, after: null };
  if (s.answered) return { send: false, exhausted: false };
  if (s.retries >= FIRE_RETRIES) return { send: false, exhausted: true };
  return { send: true, after: s.ackDueAt };
}

const later = (...ds: (Date | null | undefined)[]): Date | null => {
  let out: Date | null = null;
  for (const d of ds) if (d && (!out || d > out)) out = d;
  return out;
};

// A delivered fire, or one that maybe went, whose answer came due without
// the bot reading its number: its attempt is marked unanswered, a failure
// of its own, once. Never a test fire's.
async function markAttemptUnanswered(
  sql: postgres.Sql | Tx,
  botId: number,
  wake: number,
): Promise<void> {
  await sql`
    UPDATE fire_attempts SET outcome = 'unanswered', unanswered_at = now()
    WHERE id = (SELECT id FROM fire_attempts
                WHERE bot_id = ${botId} AND wake = ${wake} AND NOT test
                ORDER BY id DESC LIMIT 1)
      AND outcome IN ('delivered', 'maybe')`;
}

// The gap before a routine's next fire (L1c). Each fire in a row still
// unanswered (retries included), past the first, doubles it, up to claude_fire_backoff_max_seconds
// (never shorter than the gap itself), so a bot that stopped answering,
// say one whose person ran out of usage, costs its person's plan fewer and
// fewer runs; reading its number puts the count, and the gap, back. The
// first unanswered fire keeps the gap, since an arrival can come while the
// run it started is still on its way to reading the number. A person's
// test fire keeps the plain gap: it's their own click.
export function fireGapSeconds(
  a: Pick<
    AntiAbuse,
    "claude_fire_gap_seconds" | "claude_fire_backoff_max_seconds"
  >,
  openFires: number,
): number {
  const base = a.claude_fire_gap_seconds;
  const cap = Math.max(a.claude_fire_backoff_max_seconds, base);
  const doublings = Math.min(Math.max(openFires - 1, 0), 30);
  return Math.min(base * 2 ** doublings, cap);
}

// Enough fires in a row went unanswered, whatever wake each carried: marked
// once, until the bot next reads its number, counted, shown to the bot's
// person, and logged for the moderators. Whether it's marked now.
async function markUnanswered(
  sql: postgres.Sql | Tx,
  botId: number,
  atLeast: number,
): Promise<boolean> {
  const [r] = await sql<{ handle: string; wake: string; fires: number }[]>`
    UPDATE fire_state f
    SET alarmed_wake = f.fired_wake, alarmed_at = now(),
        unanswered = f.unanswered + 1
    FROM bots b
    WHERE f.bot_id = ${botId} AND b.id = f.bot_id
      AND f.open_fires >= ${atLeast} AND f.fired_wake IS NOT NULL
      AND (f.alarmed_at IS NULL OR f.alarmed_at < f.seen_at)
    RETURNING b.handle, f.fired_wake AS wake, f.open_fires AS fires`;
  if (!r) return false;
  await logAction(sql as Tx, {
    action: "alert.claude_fire_unanswered",
    botId,
    keyId: null,
    subject: `bot:${r.handle}`,
    ipHash: null,
    detail: { wake: Number(r.wake), fires: r.fires },
  });
  return true;
}

// When the daily cap lifts, if the bot's routine has fired
// claude_fire_per_day times in the last day, test fires included: the
// oldest of those fires a day on. Null under the cap. Reads no more than
// that many rows.
async function dailyCapLifts(
  sql: postgres.Sql | Tx,
  botId: number,
  perDay: number,
): Promise<Date | null> {
  const [r] = await sql<{ n: number; lifts: Date | null }[]>`
    SELECT count(*)::int AS n, min(sent_at) + interval '1 day' AS lifts
    FROM (
      SELECT sent_at FROM fire_attempts WHERE bot_id = ${botId}
      ORDER BY id DESC LIMIT ${perDay}) x
    WHERE sent_at > now() - interval '1 day'`;
  return r && r.n >= perDay ? r.lifts : null;
}

// Noted for the moderators once a day while the cap holds a routine back.
async function noteCapped(
  sql: postgres.Sql | Tx,
  botId: number,
  routine: string,
): Promise<void> {
  const [r] = await sql<{ handle: string }[]>`
    UPDATE fire_state f SET capped_at = now()
    FROM bots b
    WHERE f.bot_id = ${botId} AND b.id = f.bot_id
      AND (f.capped_at IS NULL OR f.capped_at <= now() - interval '1 day')
    RETURNING b.handle`;
  if (!r) return;
  await logAction(sql as Tx, {
    action: "claude_fire.capped",
    botId,
    keyId: null,
    subject: `bot:${r.handle}`,
    ipHash: null,
    detail: { routine },
  });
}

// Ends the bot's routine when the one in force is still the row it fired:
// a row with no routine, and its token deleted by the row's trigger. Takes
// the bot's lock (src/lib/claude-fire.ts) first.
export async function endTrigger(
  tx: Tx,
  botId: number,
  triggerId: number,
  why: "unauthorized" | "not_found",
): Promise<boolean> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`claude_fire:${botId}`}))`;
  const [cur] = await tx<
    {
      id: string;
      human_id: string;
      routine_id: string | null;
      handle: string;
    }[]
  >`
    SELECT t.id, t.human_id, t.routine_id, b.handle
    FROM fire_triggers t JOIN bots b ON b.id = t.bot_id
    WHERE t.bot_id = ${botId} ORDER BY t.id DESC LIMIT 1`;
  if (!cur?.routine_id || Number(cur.id) !== triggerId) return false;
  await tx`
    INSERT INTO fire_triggers (bot_id, human_id, ended)
    VALUES (${botId}, ${cur.human_id}, ${why})`;
  await logAction(tx, {
    action: "claude_fire.ended",
    botId,
    keyId: null,
    subject: `bot:${cur.handle}`,
    ipHash: null,
    detail: { routine: cur.routine_id, reason: why },
  });
  return true;
}

// The registration as it stands, with its token opened, and where its
// fires stand: for find() and for a person's test fire.
export async function readTrigger(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<
  | (FireState & {
      material: Material;
      routine: string;
      address: string;
      failures: number;
      lastSentAt: Date | null;
      retryAt: Date | null;
      openFires: number;
      openSince: Date | null;
      // Marked unanswered, and the bot hasn't read its number since.
      alarmed: boolean;
      now: Date;
    })
  | null
> {
  // Off the production site, no token is opened (firesAllowed).
  if (!firesAllowed()) return null;
  const [r] = await sql<
    {
      id: string;
      routine_id: string | null;
      live: boolean;
      key_version: number | null;
      iv: Buffer | null;
      sealed: Buffer | null;
      failures: number | null;
      last_sent_at: Date | null;
      retry_at: Date | null;
      fired_wake: string | null;
      answered: boolean | null;
      retries: number | null;
      ack_due_at: Date | null;
      open_fires: number | null;
      open_since: Date | null;
      alarmed: boolean | null;
      wake: string | null;
      now: Date;
    }[]
  >`
    SELECT t.id, t.routine_id, fire_trigger_live(${botId}) AS live,
           s.key_version, s.iv, s.sealed,
           st.failures, st.last_sent_at, st.retry_at, st.fired_wake,
           (st.seen_at >= st.fired_at AND st.seen_wake >= st.fired_wake) AS answered,
           st.retries, st.ack_due_at, st.open_fires, st.open_since,
           (st.alarmed_at IS NOT NULL
            AND (st.seen_at IS NULL OR st.seen_at < st.alarmed_at)) AS alarmed,
           (SELECT count FROM wake_counters WHERE bot_id = ${botId}) AS wake,
           now() AS now
    FROM fire_triggers t
      LEFT JOIN fire_secrets s ON s.trigger_id = t.id
      LEFT JOIN fire_state st ON st.bot_id = t.bot_id
    WHERE t.bot_id = ${botId} ORDER BY t.id DESC LIMIT 1`;
  if (!r?.live || !r.routine_id) return null;
  const id = Number(r.id);
  const token =
    r.key_version !== null && r.iv && r.sealed
      ? openSecret(
          botId,
          id,
          { key_version: r.key_version, iv: r.iv, sealed: r.sealed },
          "claude-fire",
        )
      : null;
  return {
    material: { id, token: token ? token.toString("utf8") : null },
    routine: r.routine_id,
    address: fireUrl(r.routine_id),
    failures: r.failures ?? 0,
    lastSentAt: r.last_sent_at,
    retryAt: r.retry_at,
    wake: Number(r.wake ?? 0),
    firedWake: r.fired_wake === null ? null : Number(r.fired_wake),
    answered: r.answered === true,
    retries: r.retries ?? 0,
    ackDueAt: r.ack_due_at,
    openFires: r.open_fires ?? 0,
    openSince: r.open_since,
    alarmed: r.alarmed === true,
    now: r.now,
  };
}

export const claudeFireAdapter: WakeAdapter = {
  name: "claude_fire",

  // Only a routine's fire URL at Anthropic's API, exactly.
  check(address) {
    if (!FIRE_URL_RE.test(address))
      throw new ApiError(
        400,
        "invalid",
        "That isn't a Claude routine's fire URL.",
      );
    return address;
  },

  // The registration when the bot needs a fire: something new since the
  // last fire, or a fire nobody answered whose wait is over. An attempt
  // whose answer is overdue, and a run of unanswered fires long enough to
  // mark, are marked here, once, in the claim's own transaction, which
  // holds the bot's push_state row: push_state before fire_state, as
  // everywhere. A fire whose retries all went unanswered, or one past the
  // daily cap, is null, and the drain goes on to the next method.
  async find(sql, botId) {
    if (!(await readTrigger(sql, botId))) return null;
    // The claim holds the bot's fire_state row from here to its commit, so
    // a person's test fire can't stamp a send between this read and the
    // claim's own stamp (claimed below); read again under the lock.
    await sql`
      INSERT INTO fire_state (bot_id) VALUES (${botId})
      ON CONFLICT (bot_id) DO NOTHING`;
    await sql`SELECT 1 FROM fire_state WHERE bot_id = ${botId} FOR UPDATE`;
    const t = await readTrigger(sql, botId);
    if (!t) return null;
    const a = await antiAbuse(sql);
    const overdue =
      !t.answered &&
      t.firedWake !== null &&
      t.ackDueAt !== null &&
      t.ackDueAt <= t.now;
    if (overdue && t.firedWake !== null)
      await markAttemptUnanswered(sql, botId, t.firedWake);
    let alarmed = t.alarmed;
    if (
      !t.answered &&
      !alarmed &&
      t.openFires >= a.claude_fire_alarm_after &&
      t.openSince !== null &&
      t.openSince.getTime() + a.claude_fire_ack_seconds * 1000 <=
        t.now.getTime()
    )
      alarmed = await markUnanswered(sql, botId, a.claude_fire_alarm_after);
    const plan = planFire(t);
    if (!plan.send) return null;
    // The backed-off gap spaces fires for new arrivals. A retry of a fire
    // whose answer is overdue keeps the plain gap: held past its answer's
    // due time, it would be waiting, and not owed, when the drain sends the
    // push URL alone, and never be queued again.
    const gap =
      plan.after === null
        ? fireGapSeconds(a, t.openFires)
        : a.claude_fire_gap_seconds;
    // Past the daily cap: not sent now, and not owed, so a method after it
    // (a push URL) goes in its place; with none, the bot stays queued for
    // when the cap lifts, and the routine fires then.
    const lifts = await dailyCapLifts(sql, botId, a.claude_fire_per_day);
    if (lifts) {
      await noteCapped(sql, botId, t.routine);
      return {
        address: t.address,
        secret: JSON.stringify(t.material),
        failures: t.failures,
        notBefore: later(lifts, plan.after),
        owed: false,
      };
    }
    return {
      address: t.address,
      // Once a fire's answer is overdue, or the routine is marked, the
      // bot's next method goes too, whether or not this one is delivered.
      secret: JSON.stringify({ ...t.material, again: overdue || alarmed }),
      failures: t.failures,
      notBefore: later(
        t.lastSentAt ? new Date(t.lastSentAt.getTime() + gap * 1000) : null,
        t.retryAt,
        plan.after,
      ),
      // A wake not yet fired is owed: a push that goes during the gap
      // doesn't stand in for it.
      owed: plan.after === null,
    };
  },

  async send(registration, note, deliver): Promise<WakeOutcome> {
    let m: Material;
    try {
      m = JSON.parse(registration.secret) as Material;
    } catch {
      return { delivered: false, status: null, error: "secret" };
    }
    if (!m.token) return { delivered: false, status: null, error: "secret" };
    // Off the production site nothing goes, whatever a caller passes in.
    if (!firesAllowed())
      return { delivered: false, status: null, error: "not_production" };
    const body = JSON.stringify({ text: fireText(note) });
    const d = await transport(deliver)(
      registration.address,
      body,
      {
        authorization: `Bearer ${m.token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "content-type": "application/json",
        "user-agent": "Unprompted-Fire/1",
      },
      { readBody: ANSWER_MAX_BYTES, timeoutMs: DELIVER_TIMEOUT_MS },
    );
    // Only the answer's type decides. Its session's id and address stay in
    // the excerpt kept on fire_attempts, as evidence a run began, and go
    // nowhere else: no log line, no read by any bot.
    let fired = false;
    if (d.status === 200 && d.body !== undefined)
      try {
        fired =
          (JSON.parse(d.body) as { type?: unknown } | null)?.type ===
          "routine_fire";
      } catch {}
    const excerpt = fireExcerpt(d.body);
    // Cut off with no answer after the whole request went out: it may have
    // started a run.
    const maybe = d.status === null && d.written === true;
    return {
      delivered: fired,
      status: d.status,
      ref: m.id,
      ...(maybe ? { maybe } : {}),
      ...(fired && m.again ? { alsoNext: true } : {}),
      ...(excerpt ? { excerpt } : {}),
      ...(d.error ? { error: d.error } : {}),
      ...(d.retryAfter !== undefined ? { retryAfter: d.retryAfter } : {}),
    };
  },

  record(sql, botId, outcome, note) {
    return recordFire(sql, botId, outcome, note, false);
  },

  // A 429 waits as its Retry-After says; a server error, no answer, or a
  // 401 or 404 that hasn't ended the routine yet is fired again once the
  // gap is over, until the pause or the end. A 400 (a malformed fire, or
  // the routine paused) and a 403 count but aren't retried. A fire that
  // maybe went isn't either: its answer is waited on.
  async retryAt(sql, botId, outcome) {
    // A fire that maybe went is waited on, never sent again at the gap.
    if (outcome.delivered || outcome.maybe) return null;
    const s = outcome.status;
    if (s !== null && s !== 429 && s !== 401 && s !== 404 && s < 500)
      return null;
    // The gap find() will hold it to: backed off while fires go
    // unanswered, so the bot isn't queued again before the routine may go.
    const a = await antiAbuse(sql);
    const [r] = await sql<
      { last_sent_at: Date | null; retry_at: Date | null; open_fires: number }[]
    >`
      SELECT st.last_sent_at, st.retry_at, st.open_fires
      FROM fire_state st
      WHERE st.bot_id = ${botId} AND fire_trigger_usable(${botId}, ${PUSH_MAX_FAILURES})`;
    if (!r?.last_sent_at) return r?.retry_at ?? null;
    const gap = fireGapSeconds(a, r.open_fires ?? 0);
    return later(new Date(r.last_sent_at.getTime() + gap * 1000), r.retry_at);
  },

  // Tokens nothing can fire with any more go, in case a change slipped past
  // the triggers that delete them: one whose row isn't the newest for its
  // bot, or whose bot is no longer linked to the person who saved it.
  async sweep(sql) {
    await sql`
      DELETE FROM fire_secrets s
      WHERE NOT EXISTS (
        SELECT 1 FROM fire_triggers t JOIN bots b ON b.id = t.bot_id
        WHERE t.id = s.trigger_id AND t.routine_id IS NOT NULL
          AND b.owner_id = t.human_id
          AND t.id = (SELECT max(x.id) FROM fire_triggers x WHERE x.bot_id = t.bot_id))`;
  },

  async cap(tx) {
    return { key: "claude_fire", rules: claudeFireRules(await antiAbuse(tx)) };
  },

  // The send starts now, by the database's clock: find()'s gap counts from
  // here, so a claim while the fire is still in flight (it may take up to
  // FIRE_DEADLINE_MS, longer than the push gap) finds it inside the gap and
  // sends no second one. record() takes this stamp as when the fire went.
  async claimed(tx, botId) {
    await tx`UPDATE fire_state SET last_sent_at = now() WHERE bot_id = ${botId}`;
  },

  deadlineMs: FIRE_DEADLINE_MS,
};

// Keeps how a fire went. Every try starts the gap again. A delivered fire,
// or one that maybe went, is waited on: the bot is queued for when its
// answer is due (push_state.fire_check), so the clock fires it once more if
// nobody read the number by then. A person's test fire (test) is kept as
// evidence and counts toward the pause, the gap and the end, but is never
// waited on and leaves the wait on the drain's own fires as it stands. A
// 401 or a 404 says the token or the routine is gone; FIRE_GONE_ANSWERS of
// them in a row, over FIRE_GONE_HOURS at least, end the registration, and
// the drain goes on to the next method.
//
// Lock order: the bot's routine lock (when it may end), then its
// push_state row, then its fire_state row, as saving and ackWake take them
// and as the drain's claim holds push_state while find() writes fire_state.
export async function recordFire(
  sql: postgres.Sql,
  botId: number,
  outcome: WakeOutcome,
  note: WakeNote | undefined,
  test: boolean,
): Promise<void> {
  const a = await antiAbuse(sql);
  const retryAfter =
    outcome.status === 429
      ? Math.min(
          Math.max(outcome.retryAfter ?? a.claude_fire_gap_seconds, 1),
          RETRY_AFTER_MAX_SECONDS,
        )
      : null;
  const gone =
    (outcome.status === 401 || outcome.status === 404) &&
    outcome.ref !== undefined;
  const maybe = !outcome.delivered && outcome.maybe === true;
  const waits = (outcome.delivered || maybe) && note !== undefined && !test;
  await sql.begin(async (tx) => {
    if (gone)
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`claude_fire:${botId}`}))`;
    await tx`SELECT 1 FROM push_state WHERE bot_id = ${botId} FOR NO KEY UPDATE`;
    // When the fire went: the stamp its claim, or the test fire's first
    // transaction, wrote by the database's clock before sending, which
    // nothing moves while it's in flight (the gap outlasts the deadline).
    const [stamp] = await tx<{ at: Date | null }[]>`
      SELECT last_sent_at AS at FROM fire_state
      WHERE bot_id = ${botId} FOR UPDATE`;
    const sentAt = stamp?.at ?? outcome.sentAt ?? new Date();
    // An answer that isn't a 401 or a 404 breaks a run of them; no answer
    // leaves it as it stands.
    const [st] = await tx<{ gone_answers: number; gone_long: boolean }[]>`
      INSERT INTO fire_state
        (bot_id, last_sent_at, last_status, failures, delivered, failed,
         retry_at, gone_answers, gone_since)
      VALUES (${botId}, ${sentAt}, ${outcome.status},
              ${outcome.delivered || maybe ? 0 : 1},
              ${outcome.delivered ? 1 : 0},
              ${outcome.delivered || maybe ? 0 : 1},
              now() + make_interval(secs => ${retryAfter}),
              ${gone ? 1 : 0}, ${gone ? sentAt : null})
      ON CONFLICT (bot_id) DO UPDATE
        SET last_sent_at = ${sentAt}, last_status = EXCLUDED.last_status,
            failures = CASE WHEN ${outcome.delivered} THEN 0
                            WHEN ${maybe} THEN fire_state.failures
                            ELSE fire_state.failures + 1 END,
            delivered = fire_state.delivered + EXCLUDED.delivered,
            failed = fire_state.failed + EXCLUDED.failed,
            retry_at = EXCLUDED.retry_at,
            gone_answers = CASE WHEN ${gone} THEN fire_state.gone_answers + 1
                                WHEN ${outcome.status}::int IS NOT NULL THEN 0
                                ELSE fire_state.gone_answers END,
            gone_since = CASE WHEN ${gone}
                                THEN COALESCE(fire_state.gone_since, ${sentAt})
                              WHEN ${outcome.status}::int IS NOT NULL THEN NULL
                              ELSE fire_state.gone_since END
      RETURNING gone_answers,
        COALESCE(gone_since <= now() - make_interval(hours => ${FIRE_GONE_HOURS}),
                 false) AS gone_long`;
    if (waits && note) {
      // A fire of the same number that went unanswered is a retry; any
      // other starts the count afresh. Its answer is due after the wait,
      // doubled for each retry, and never sooner than the gap, counted from
      // when the send started, as fired_at is: a read of the number after
      // that answers it, even one that came before this row was written.
      const [w] = await tx<{ waiting: boolean }[]>`
        WITH cur AS (
          SELECT CASE WHEN fired_wake = ${note.wake}
                       AND NOT COALESCE(seen_at >= fired_at AND seen_wake >= fired_wake, false)
                      THEN retries + 1 ELSE 0 END AS r,
                 COALESCE(seen_at >= ${sentAt} AND seen_wake >= ${note.wake},
                          false) AS seen
          FROM fire_state WHERE bot_id = ${botId})
        UPDATE fire_state f
        SET retries = cur.r, fired_wake = ${note.wake}, fired_at = ${sentAt},
            ack_due_at = ${sentAt}::timestamptz + make_interval(secs => GREATEST(
              ${a.claude_fire_ack_seconds} * power(2, LEAST(cur.r, ${FIRE_RETRIES})),
              ${a.claude_fire_gap_seconds})),
            open_fires = CASE WHEN cur.seen THEN 0 ELSE f.open_fires + 1 END,
            open_since = CASE WHEN cur.seen THEN NULL
                              ELSE COALESCE(f.open_since, ${sentAt}) END
        FROM cur WHERE f.bot_id = ${botId}
        RETURNING NOT cur.seen AS waiting`;
      // Queued for the answer's check, marked as only that, so an arrival
      // brings it forward (bump_wake, 062_claude_fire_fixes.sql). Not when
      // an arrival already queued it, nor when the bot already answered.
      if (w?.waiting)
        await tx`
          UPDATE push_state p
          SET pending_since = f.ack_due_at, fire_check = true
          FROM fire_state f
          WHERE p.bot_id = ${botId} AND f.bot_id = ${botId}
            AND p.pending_since IS NULL`;
    }
    // The evidence: one row a send, never the token or the headers.
    if (note)
      await tx`
        INSERT INTO fire_attempts
          (bot_id, trigger_id, wake, attempt, sent_at, outcome, status,
           retry_after, excerpt, test)
        SELECT ${botId}, t.id, ${note.wake},
               (SELECT count(*)::int + 1 FROM fire_attempts a
                WHERE a.bot_id = ${botId} AND a.trigger_id = t.id
                  AND a.wake = ${note.wake}),
               ${sentAt}, ${outcomeClass(outcome)},
               ${outcome.status},
               ${outcome.retryAfter === undefined ? null : Math.min(outcome.retryAfter, 2_000_000_000)},
               ${fireExcerpt(outcome.excerpt)}, ${test}
        FROM fire_triggers t
        WHERE t.id = COALESCE(${outcome.ref ?? null}::bigint,
          (SELECT max(id) FROM fire_triggers
           WHERE bot_id = ${botId} AND routine_id IS NOT NULL))`;
    if (
      gone &&
      outcome.ref !== undefined &&
      st &&
      st.gone_answers >= FIRE_GONE_ANSWERS &&
      st.gone_long
    )
      await endTrigger(
        tx as unknown as Tx,
        botId,
        outcome.ref,
        outcome.status === 401 ? "unauthorized" : "not_found",
      );
  });
}
