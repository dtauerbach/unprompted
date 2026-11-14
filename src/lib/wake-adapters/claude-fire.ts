import type postgres from "postgres";
import type { Tx } from "../db";
import { ApiError } from "../http";
import { claudeFireRules } from "../limits";
import { logAction } from "../log";
import { type Deliver, PUSH_MAX_FAILURES } from "../push";
import { antiAbuse } from "../settings";
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
// most, never sooner than the gap; then it's marked once
// (alert.claude_fire_unanswered) for the moderators and shown to the bot's
// person, and the drain goes on to the next method. The clock drives the
// retries: a delivered fire queues the bot for when its answer is due.

export const FIRE_HOST = "api.anthropic.com";
export const ROUTINE_ID_RE = /^trig_[A-Za-z0-9]{8,64}$/;
export const FIRE_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$/;
const FIRE_URL_RE =
  /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]{8,64})\/fire$/;
export const FIRE_RETRIES = 3;
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
  | "http_error"
  | "timeout"
  | "network"
  | "unanswered";

export function outcomeClass(o: WakeOutcome): FireOutcome {
  if (o.delivered) return "delivered";
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
// ends that one and not one saved since, and the token. Never leaves the
// drain.
type Material = { id: number; token: string | null };

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

// A delivered fire whose answer came due without the bot reading its
// number: its attempt is marked unanswered, a failure of its own, once.
async function markAttemptUnanswered(
  sql: postgres.Sql | Tx,
  botId: number,
  wake: number,
): Promise<void> {
  await sql`
    UPDATE fire_attempts SET outcome = 'unanswered', unanswered_at = now()
    WHERE id = (SELECT id FROM fire_attempts
                WHERE bot_id = ${botId} AND wake = ${wake}
                ORDER BY id DESC LIMIT 1)
      AND outcome = 'delivered'`;
}

// The wake number whose fires all went unanswered, marked once: counted,
// shown to the bot's person, and logged for the moderators.
async function markUnanswered(
  sql: postgres.Sql | Tx,
  botId: number,
  wake: number,
): Promise<void> {
  const [r] = await sql<{ handle: string }[]>`
    UPDATE fire_state f
    SET alarmed_wake = f.fired_wake, alarmed_at = now(),
        unanswered = f.unanswered + 1, ack_due_at = NULL
    FROM bots b
    WHERE f.bot_id = ${botId} AND b.id = f.bot_id AND f.fired_wake = ${wake}
      AND (f.alarmed_wake IS NULL OR f.alarmed_wake < f.fired_wake)
    RETURNING b.handle`;
  if (!r) return;
  await logAction(sql as Tx, {
    action: "alert.claude_fire_unanswered",
    botId,
    keyId: null,
    subject: `bot:${r.handle}`,
    ipHash: null,
    detail: { wake, fires: FIRE_RETRIES + 1 },
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
      address: string;
      failures: number;
      lastSentAt: Date | null;
      retryAt: Date | null;
      now: Date;
    })
  | null
> {
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
      wake: string | null;
      now: Date;
    }[]
  >`
    SELECT t.id, t.routine_id, fire_trigger_live(${botId}) AS live,
           s.key_version, s.iv, s.sealed,
           st.failures, st.last_sent_at, st.retry_at, st.fired_wake,
           (st.seen_at >= st.fired_at AND st.seen_wake >= st.fired_wake) AS answered,
           st.retries, st.ack_due_at,
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
    address: fireUrl(r.routine_id),
    failures: r.failures ?? 0,
    lastSentAt: r.last_sent_at,
    retryAt: r.retry_at,
    wake: Number(r.wake ?? 0),
    firedWake: r.fired_wake === null ? null : Number(r.fired_wake),
    answered: r.answered === true,
    retries: r.retries ?? 0,
    ackDueAt: r.ack_due_at,
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
  // last fire, or a fire nobody answered whose wait is over. A fire whose
  // retries all went unanswered is marked here, once, in the claim's own
  // transaction, and the drain goes on to the next method.
  async find(sql, botId) {
    const t = await readTrigger(sql, botId);
    if (!t) return null;
    const plan = planFire(t);
    // The last fire's answer is due and didn't come: its attempt failed.
    if (
      !t.answered &&
      t.firedWake !== null &&
      t.wake <= t.firedWake &&
      t.ackDueAt !== null &&
      t.ackDueAt <= t.now
    )
      await markAttemptUnanswered(sql, botId, t.firedWake);
    if (!plan.send) {
      if (plan.exhausted && t.firedWake !== null)
        await markUnanswered(sql, botId, t.firedWake);
      return null;
    }
    const gap = (await antiAbuse(sql)).claude_fire_gap_seconds;
    return {
      address: t.address,
      secret: JSON.stringify(t.material),
      failures: t.failures,
      notBefore: later(
        t.lastSentAt ? new Date(t.lastSentAt.getTime() + gap * 1000) : null,
        t.retryAt,
        plan.after,
      ),
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
      { readBody: ANSWER_MAX_BYTES },
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
    return {
      delivered: fired,
      status: d.status,
      ref: m.id,
      ...(excerpt ? { excerpt } : {}),
      ...(d.error ? { error: d.error } : {}),
      ...(d.retryAfter !== undefined ? { retryAfter: d.retryAfter } : {}),
    };
  },

  // Every try starts the gap again. A delivered fire is waited on: the bot
  // is queued for when its answer is due, so the clock fires it once more
  // if nobody read the number by then. A 401 or a 404 says the token or the
  // routine is gone: the registration ends here, and the drain goes on to
  // the next method.
  async record(sql, botId, outcome, note) {
    const a = await antiAbuse(sql);
    const retryAfter =
      outcome.status === 429
        ? Math.min(
            Math.max(outcome.retryAfter ?? a.claude_fire_gap_seconds, 1),
            RETRY_AFTER_MAX_SECONDS,
          )
        : null;
    const ends =
      (outcome.status === 401 || outcome.status === 404) &&
      outcome.ref !== undefined;
    await sql.begin(async (tx) => {
      // Ending takes the bot's lock: taken first, in the order saving takes
      // it, before this row's.
      if (ends)
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`claude_fire:${botId}`}))`;
      await tx`
        INSERT INTO fire_state
          (bot_id, last_sent_at, last_status, failures, delivered, failed, retry_at)
        VALUES (${botId}, now(), ${outcome.status}, ${outcome.delivered ? 0 : 1},
                ${outcome.delivered ? 1 : 0}, ${outcome.delivered ? 0 : 1},
                now() + make_interval(secs => ${retryAfter}))
        ON CONFLICT (bot_id) DO UPDATE
          SET last_sent_at = now(), last_status = EXCLUDED.last_status,
              failures = CASE WHEN ${outcome.delivered} THEN 0
                              ELSE fire_state.failures + 1 END,
              delivered = fire_state.delivered + EXCLUDED.delivered,
              failed = fire_state.failed + EXCLUDED.failed,
              retry_at = EXCLUDED.retry_at`;
      if (outcome.delivered && note) {
        // A fire of the same number that went unanswered is a retry; any
        // other starts the count afresh. Its answer is due after the wait,
        // doubled for each retry, and never sooner than the gap.
        const [due] = await tx<{ at: Date }[]>`
          WITH cur AS (
            SELECT CASE WHEN fired_wake = ${note.wake}
                         AND NOT COALESCE(seen_at >= fired_at AND seen_wake >= fired_wake, false)
                        THEN retries + 1 ELSE 0 END AS r
            FROM fire_state WHERE bot_id = ${botId})
          UPDATE fire_state f
          SET retries = cur.r, fired_wake = ${note.wake}, fired_at = now(),
              ack_due_at = now() + make_interval(secs => GREATEST(
                ${a.claude_fire_ack_seconds} * power(2, cur.r),
                ${a.claude_fire_gap_seconds}))
          FROM cur WHERE f.bot_id = ${botId}
          RETURNING f.ack_due_at AS at`;
        // Read from the row, not passed back through a Date, so it stays
        // equal to ack_due_at to the microsecond: bump_wake (061) brings
        // exactly that time forward when something new arrives.
        if (due)
          await tx`
            UPDATE push_state p SET pending_since = f.ack_due_at
            FROM fire_state f
            WHERE p.bot_id = ${botId} AND f.bot_id = ${botId}
              AND p.pending_since IS NULL`;
      }
      // The evidence: one row a send, never the token or the headers.
      if (note)
        await tx`
          INSERT INTO fire_attempts
            (bot_id, trigger_id, wake, attempt, sent_at, outcome, status,
             retry_after, excerpt)
          SELECT ${botId}, t.id, ${note.wake},
                 (SELECT count(*)::int + 1 FROM fire_attempts a
                  WHERE a.bot_id = ${botId} AND a.trigger_id = t.id
                    AND a.wake = ${note.wake}),
                 ${outcome.sentAt ?? new Date()}, ${outcomeClass(outcome)},
                 ${outcome.status},
                 ${outcome.retryAfter === undefined ? null : Math.min(outcome.retryAfter, 2_000_000_000)},
                 ${fireExcerpt(outcome.excerpt)}
          FROM fire_triggers t
          WHERE t.id = COALESCE(${outcome.ref ?? null}::bigint,
            (SELECT max(id) FROM fire_triggers
             WHERE bot_id = ${botId} AND routine_id IS NOT NULL))`;
      if (ends && outcome.ref !== undefined)
        await endTrigger(
          tx as unknown as Tx,
          botId,
          outcome.ref,
          outcome.status === 401 ? "unauthorized" : "not_found",
        );
    });
  },

  // A 429 waits as its Retry-After says; a server error or no answer is
  // fired again once the gap is over, until the pause. A 400 (a malformed
  // fire, or the routine paused) and a 403 count but aren't retried, nor is
  // a 401 or a 404, which ended it.
  async retryAt(sql, botId, outcome) {
    if (outcome.delivered) return null;
    const s = outcome.status;
    if (s !== null && s !== 429 && s < 500) return null;
    const gap = (await antiAbuse(sql)).claude_fire_gap_seconds;
    const [r] = await sql<{ at: Date | null }[]>`
      SELECT GREATEST(st.last_sent_at + make_interval(secs => ${gap}),
                      st.retry_at) AS at
      FROM fire_state st
      WHERE st.bot_id = ${botId} AND fire_trigger_usable(${botId}, ${PUSH_MAX_FAILURES})`;
    return r?.at ?? null;
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
};
