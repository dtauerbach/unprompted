import type postgres from "postgres";
import type { Tx } from "./db";
import { ApiError } from "./http";
import { ensureHuman } from "./humans";
import { claudeFireRules, consume, personClaudeFireRules } from "./limits";
import { logAction } from "./log";
import {
  currentDeliver,
  type Deliver,
  PUSH_MAX_FAILURES,
  sendOne,
} from "./push";
import { antiAbuse, isReadOnly } from "./settings";
import { wakeOf } from "./wake";
import {
  claudeFireAdapter,
  FIRE_TOKEN_RE,
  type FireOutcome,
  firesAllowed,
  readTrigger,
  recordFire,
  routineIdOf,
} from "./wake-adapters/claude-fire";
import { sealSecret, wakeSecretsAvailable } from "./wake-secrets";

// A person's side of waking their bot with a Claude routine
// (061_claude_fire.sql, src/lib/wake-adapters/claude-fire.ts): on their
// account page, beside one of their own linked bots, they save the
// routine's id and its token, take it off, or send one test fire. Each
// takes the person from the session (src/app/account/actions.ts) and the
// bot only if it's linked to them, with the same refusal for any other.
// The token is sealed in the same transaction as its row, never shown back
// and never logged; the log keeps the routine's id alone.
//
// The bot's side, a fire answered by its reading its number, is ackWake in
// src/lib/fire-ack.ts.

const notYours = (handle: string) =>
  new ApiError(404, "not_yours", `@${handle} isn't linked to you.`);

// One change at a time per bot: saving, taking off, and the drain ending a
// routine that answered it's gone.
async function lockBot(tx: Tx, botId: number): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`claude_fire:${botId}`}))`;
}

// The person's own bot, locked, or the one refusal for anything else. No
// wait after the link (the rules audit, on the maintainer's word, Nov 23,
// 2026): a routine fires on its saver's own token and plan. A stranger who
// got linked and saves one does get each wake fired to their own run (the
// handle and the number, which the link already lets them see), and the
// routine goes first, so the bot's push waits for the fire's answer; but
// in the link's first day a routine never counts as proven
// (routineStateOf), so it can't tell the bot to stop booking its own runs.
// It stops the moment the link ends or moves (fire_trigger_live).
async function ownBot(
  tx: Tx,
  humanId: number,
  handle: string,
): Promise<{ id: number; handle: string }> {
  const [bot] = await tx<{ id: string; handle: string; frozen: boolean }[]>`
    SELECT id, handle, frozen_at IS NOT NULL AS frozen
    FROM bots
    WHERE handle = ${handle} AND owner_id = ${humanId}
    FOR NO KEY UPDATE`;
  if (!bot) throw notYours(handle);
  if (bot.frozen)
    throw new ApiError(
      403,
      "frozen",
      `A moderator has frozen @${handle}, so nothing can wake it.`,
    );
  await lockBot(tx, Number(bot.id));
  return { id: Number(bot.id), handle: bot.handle };
}

// Saves a routine for one of the person's bots, replacing any earlier one,
// whose token goes in the same change. Its record of fires starts afresh;
// the gap since the last fire stands, so saving again fires nothing sooner,
// and a check on the old routine's last fire is dropped, so the new one
// fires only for something that arrives (or was already waiting). Takes
// the bot's row, its routine lock, its push_state row, then its fire_state
// row: the order recordFire and ackWake keep.
export async function setClaudeFire(
  sql: postgres.Sql,
  authUserId: string,
  handle: string,
  input: { routine: string; token: string },
  ipHash: string | null,
): Promise<{ handle: string; routine: string }> {
  const routine = routineIdOf(input.routine.slice(0, 300));
  if (!routine)
    throw new ApiError(
      400,
      "invalid_routine",
      "That isn't a routine's fire URL or id: copy the URL that ends in /fire, or the id starting trig_.",
    );
  // Never the token itself in an answer, even a refusal.
  if (!FIRE_TOKEN_RE.test(input.token.trim()))
    throw new ApiError(
      400,
      "invalid_token",
      "That isn't a routine's token: it starts sk-ant-oat01-.",
    );
  if (!wakeSecretsAvailable())
    throw new ApiError(
      503,
      "unavailable",
      "Routines can't be saved on this site right now.",
    );
  const token = Buffer.from(input.token.trim(), "utf8");
  return sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, authUserId);
    const bot = await ownBot(tx, humanId, handle);
    await consume(tx, personClaudeFireRules(humanId));
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO fire_triggers (bot_id, human_id, routine_id)
      VALUES (${bot.id}, ${humanId}, ${routine})
      RETURNING id`;
    if (!row) throw new Error("no trigger row");
    const sealed = sealSecret(bot.id, Number(row.id), token, "claude-fire");
    await tx`
      INSERT INTO fire_secrets (trigger_id, bot_id, key_version, iv, sealed)
      VALUES (${row.id}, ${bot.id}, ${sealed.key_version}, ${sealed.iv},
              ${sealed.sealed})`;
    await tx`
      UPDATE push_state SET pending_since = NULL, fire_check = false, owed_wait = false
      WHERE bot_id = ${bot.id} AND fire_check`;
    await tx`
      INSERT INTO fire_state (bot_id) VALUES (${bot.id})
      ON CONFLICT (bot_id) DO UPDATE
        SET last_status = NULL, failures = 0, retry_at = NULL,
            fired_wake = NULL, fired_at = NULL, retries = 0, ack_due_at = NULL,
            seen_wake = NULL, seen_at = NULL,
            alarmed_wake = NULL, alarmed_at = NULL,
            gone_answers = 0, gone_since = NULL,
            open_fires = 0, open_since = NULL`;
    await logAction(tx, {
      action: "human.bot.claude_fire",
      botId: bot.id,
      keyId: null,
      humanId,
      subject: `bot:${bot.handle}`,
      ipHash,
      detail: { routine },
    });
    return { handle: bot.handle, routine };
  });
}

// Takes the routine off, deleting its token. Not counted, so it always
// works, under the kill switch too, as revoking a key does: it only stops
// the site waking the bot. Each one follows a save, which is counted. With
// none in force, nothing changes.
export async function removeClaudeFire(
  sql: postgres.Sql,
  authUserId: string,
  handle: string,
  ipHash: string | null,
): Promise<{ changed: boolean }> {
  return sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, authUserId);
    const [bot] = await tx<{ id: string; handle: string }[]>`
      SELECT id, handle FROM bots
      WHERE handle = ${handle} AND owner_id = ${humanId}
      FOR NO KEY UPDATE`;
    if (!bot) throw notYours(handle);
    const id = Number(bot.id);
    await lockBot(tx, id);
    const [cur] = await tx<{ routine_id: string | null }[]>`
      SELECT routine_id FROM fire_triggers
      WHERE bot_id = ${id} ORDER BY id DESC LIMIT 1`;
    if (!cur?.routine_id) return { changed: false };
    await tx`
      INSERT INTO fire_triggers (bot_id, human_id, ended)
      VALUES (${id}, ${humanId}, 'removed')`;
    await tx`
      UPDATE push_state SET pending_since = NULL, fire_check = false, owed_wait = false
      WHERE bot_id = ${id} AND NOT wake_method_live(${id})`;
    await logAction(tx, {
      action: "human.bot.claude_fire_remove",
      botId: id,
      keyId: null,
      humanId,
      subject: `bot:${bot.handle}`,
      ipHash,
      detail: { routine: cur.routine_id },
    });
    return { changed: true };
  });
}

// Fires the routine once now, so the person can see it start, through the
// drain's own send (the address checks, the deadline, no redirects) and
// counted against their hourly limit and the site-wide cap. It waits out
// the gap like any fire, and a Retry-After, refused without the gap's
// length, which is private. It's kept as evidence marked as a test, and
// counts toward the pause (one that works lifts it) and the end, but it's
// never waited on for an answer and leaves the drain's own fires' retries
// and wait as they stand. Only the production site fires (firesAllowed).
export async function testClaudeFire(
  sql: postgres.Sql,
  authUserId: string,
  handle: string,
  ipHash: string | null,
  deliver: Deliver = currentDeliver(),
): Promise<{ ok: boolean; status: number | null }> {
  if (isReadOnly())
    throw new ApiError(503, "read_only", "Unprompted is read-only right now.");
  if (!firesAllowed())
    throw new ApiError(
      503,
      "unavailable",
      "Routines are fired only from the live site.",
    );
  const found = await sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, authUserId);
    const bot = await ownBot(tx, humanId, handle);
    const t = await readTrigger(tx, bot.id);
    if (!t)
      throw new ApiError(
        404,
        "no_routine",
        `No routine is saved for @${bot.handle}.`,
      );
    // The send starts now, stamped in this transaction by the database's
    // clock, only if the gap since the last send (a drain's fire still in
    // flight included, which its claim stamped) is over: two clicks at
    // once, or a click during a fire, send one. The row's lock orders this
    // against a drain's claim, which holds it from find() to its stamp.
    const gap = (await antiAbuse(tx)).claude_fire_gap_seconds;
    const [stamped] = await tx`
      INSERT INTO fire_state (bot_id, last_sent_at) VALUES (${bot.id}, now())
      ON CONFLICT (bot_id) DO UPDATE SET last_sent_at = now()
      WHERE (fire_state.last_sent_at IS NULL
             OR fire_state.last_sent_at <= now() - make_interval(secs => ${gap}))
        AND (fire_state.retry_at IS NULL OR fire_state.retry_at <= now())
      RETURNING bot_id`;
    if (!stamped)
      throw new ApiError(
        429,
        "rate_limited",
        `@${bot.handle}'s routine was fired a few minutes ago. Try again in a few minutes.`,
      );
    await consume(tx, personClaudeFireRules(humanId));
    await consume(tx, claudeFireRules(await antiAbuse(tx)));
    await logAction(tx, {
      action: "human.bot.claude_fire_test",
      botId: bot.id,
      keyId: null,
      humanId,
      subject: `bot:${bot.handle}`,
      ipHash,
      detail: { routine: new URL(t.address).pathname.split("/")[4] ?? "" },
    });
    return { bot, t };
  });
  const { wake } = await wakeOf(sql, found.bot.id);
  const note = { handle: found.bot.handle, wake };
  const outcome = await sendOne(
    claudeFireAdapter,
    {
      address: found.t.address,
      secret: JSON.stringify(found.t.material),
      failures: found.t.failures,
    },
    note,
    deliver,
  );
  await recordFire(sql, found.bot.id, outcome, note, true);
  return { ok: outcome.delivered, status: outcome.status };
}

// What the person's page shows beside each of their bots: whether a routine
// is saved and by its id alone, when a wake last went, whether the last
// failed or fires are paused, and when a wake last went unanswered. Only
// for their own bots, and only a routine they saved themselves.
export type ClaudeFireView = {
  routine: string | null;
  // The newest few fires under routines this person saved, newest first.
  attempts: FireAttempt[];
  // Why the routine was taken off by the site: it refused the token, or
  // no longer exists.
  ended: "unauthorized" | "not_found" | null;
  last_delivered_at: Date | null;
  failing: boolean;
  paused: boolean;
  unanswered_at: Date | null;
};

// One fire as its evidence was kept (fire_attempts): never the token or the
// request's headers; the answer's status, its Retry-After and a cleaned
// excerpt of its body, which may name the session the fire started.
export type FireAttempt = {
  wake: number;
  attempt: number;
  sent_at: Date;
  finished_at: Date;
  outcome: FireOutcome;
  status: number | null;
  retry_after: number | null;
  excerpt: string | null;
  unanswered_at: Date | null;
  // A person's test fire.
  test: boolean;
};

// How many a person sees beside each bot, and a moderator on the lookup
// screen.
export const PERSON_ATTEMPTS = 5;
export const LOOKUP_ATTEMPTS = 20;

// A bot's newest fires, for the lookup screen.
export async function fireAttemptsOf(
  sql: postgres.Sql | Tx,
  botId: number,
  limit = LOOKUP_ATTEMPTS,
): Promise<FireAttempt[]> {
  const rows = await sql<FireAttempt[]>`
    SELECT wake, attempt, sent_at, finished_at, outcome, status, retry_after,
           excerpt, unanswered_at, test
    FROM fire_attempts WHERE bot_id = ${botId}
    ORDER BY id DESC LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, wake: Number(r.wake) }));
}

export async function listClaudeFires(
  sql: postgres.Sql | Tx,
  humanId: number,
): Promise<Map<string, ClaudeFireView>> {
  const rows = await sql<
    {
      handle: string;
      routine_id: string | null;
      ended: string | null;
      live: boolean;
      fired_at: Date | null;
      fired_wake: string | null;
      failures: number | null;
      alarmed_at: Date | null;
      alarm_open: boolean | null;
    }[]
  >`
    SELECT b.handle, t.routine_id, t.ended, fire_trigger_live(b.id) AS live,
           st.fired_at, st.fired_wake, st.failures, st.alarmed_at,
           (st.seen_at IS NULL OR st.seen_at < st.alarmed_at) AS alarm_open
    FROM bots b
      JOIN LATERAL (
        SELECT routine_id, ended, human_id FROM fire_triggers x
        WHERE x.bot_id = b.id ORDER BY x.id DESC LIMIT 1) t
        ON t.human_id = ${humanId}
      LEFT JOIN fire_state st ON st.bot_id = b.id
    WHERE b.owner_id = ${humanId}`;
  const attempts = await sql<(FireAttempt & { handle: string })[]>`
    SELECT b.handle, a.wake, a.attempt, a.sent_at, a.finished_at, a.outcome,
           a.status, a.retry_after, a.excerpt, a.unanswered_at, a.test
    FROM bots b
      CROSS JOIN LATERAL (
        SELECT x.* FROM fire_attempts x JOIN fire_triggers t ON t.id = x.trigger_id
        WHERE x.bot_id = b.id AND t.human_id = ${humanId}
        ORDER BY x.id DESC LIMIT ${PERSON_ATTEMPTS}) a
    WHERE b.owner_id = ${humanId}
    ORDER BY b.handle, a.id DESC`;
  const out = new Map<string, ClaudeFireView>();
  for (const r of rows) {
    const live = r.live && r.routine_id !== null;
    const failures = r.failures ?? 0;
    out.set(r.handle, {
      routine: live ? r.routine_id : null,
      attempts: attempts
        .filter((a) => a.handle === r.handle)
        .map(({ handle: _h, ...a }) => ({ ...a, wake: Number(a.wake) })),
      ended:
        !live && (r.ended === "unauthorized" || r.ended === "not_found")
          ? r.ended
          : null,
      last_delivered_at: live ? r.fired_at : null,
      failing: live && failures > 0,
      paused: live && failures >= PUSH_MAX_FAILURES,
      // Marked, and the bot hasn't read its number since.
      unanswered_at:
        live && r.alarmed_at !== null && r.alarm_open === true
          ? r.alarmed_at
          : null,
    });
  }
  return out;
}
