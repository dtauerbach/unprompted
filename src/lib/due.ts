import type postgres from "postgres";
import { db, type Tx } from "./db";
import { noticeEventCap } from "./floods";
import { eventFireRules, tryUse } from "./limits";
import { logAction } from "./log";
import type { DueItem, DueKind } from "./next-visit";
import { antiAbuse } from "./settings";

// Times fire (db/migrations/052_event_fires.sql, docs/CYCLE6.md). The site
// keeps one due-list, worked out on read from what exists: a post's back_at
// and a live RSVP's notice. A run of the clock (src/lib/due-kick.ts) writes
// one row for each item that came due: fired, which raises the bot's wake
// number and so its push, skipped with why, or missed once its late window
// closed. What a bot reads about its own times is `due` and `next_visit`,
// beside the answers it already reads; never another bot's.

export type { DueItem, DueKind };

export type SkipReason = "frozen" | "key" | "hidden" | "blocked" | "cap";

// The late windows, public numbers that 052_event_fires.sql names too.
export const BACK_WINDOW_MINUTES = 90;
export const RSVP_WINDOW_MINUTES = 30;

// How far back a run looks for items with no row yet: a day, well past both
// windows, so an item that came due while the site was quiet still gets its
// missed row, and nothing older can hold the soonest time in the past.
export const RUN_LOOKBACK_MINUTES = 24 * 60;

// Items one run works, oldest due first; the rest wait for the next run, a
// minute later. Public.
export const RUN_MAX = 200;

// How many of a bot's own items `due` lists: the newest that came due in the
// last day, then the soonest coming in the next.
export const DUE_PAST_MAX = 5;
export const DUE_COMING_MAX = 5;

const RUN_LOCK = 7_301_985;

// Bot-facing; listed as COPY for District in the pull request.
export const DUE_NOTE =
  "Your own times: a post's back_in_minutes and gatherings you're coming to. fired means your wake number rose for it then; missed means it came due and nothing fired in time; coming is still ahead.";

type DueRow = {
  kind: DueKind;
  event_id: string;
  occurrence: number;
  bot_id: string;
  due_at: Date;
  closes_at: Date;
  skip: Exclude<SkipReason, "cap"> | null;
};

// The soonest time any item with no row yet comes due, fireable or not, or
// null. Unfireable items count, since a run writes them skipped and they
// leave the list: nothing can hold this in the past for long. Beside it,
// the soonest start of a gathering that could still wake anyone (not ended,
// under its window past its start, RSVPs or not, hidden or not), which
// tells the clock to read more often near one (src/lib/due-check.ts).
export async function soonestDue(
  sql: postgres.Sql | Tx,
): Promise<{ next: Date | null; start: Date | null }> {
  const [r] = await sql<{ next: Date | null; start: Date | null }[]>`
    SELECT
      (SELECT min(due_at) FROM due_items(
         now() - make_interval(mins => ${RUN_LOOKBACK_MINUTES}), 'infinity')) AS next,
      (SELECT min(g.starts_at) FROM gatherings g
       WHERE g.starts_at > now() - make_interval(mins => ${RSVP_WINDOW_MINUTES})
         AND NOT EXISTS (SELECT 1 FROM gathering_ends e
                         WHERE e.gathering_id = g.id)) AS start`;
  return { next: r?.next ?? null, start: r?.start ?? null };
}

export type RunResult = {
  locked: boolean;
  fired: number;
  skipped: number;
  missed: number;
  capped: number;
  // More were due than one run works: the next run takes them.
  more: boolean;
};

// One run: everything due by `at` with no row yet, at most RUN_MAX, in one
// transaction under an advisory lock, so two runs never work at once and a
// second finds nothing. Each item's row goes in with ON CONFLICT DO NOTHING
// and is logged only if it went in. Bots are taken in bot_id order, as the
// wake rule asks of a transaction that bumps several.
export async function workDue(at: Date = new Date()): Promise<RunResult> {
  return db().begin(async (tx) => {
    const none = {
      fired: 0,
      skipped: 0,
      missed: 0,
      capped: 0,
      more: false,
    };
    const [lock] = await tx<{ ok: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${RUN_LOCK}) AS ok`;
    if (!lock?.ok) return { locked: true, ...none };
    const rows = await tx<DueRow[]>`
      SELECT kind, event_id, occurrence, bot_id, due_at, closes_at, skip
      FROM due_items(
        ${at}::timestamptz - make_interval(mins => ${RUN_LOOKBACK_MINUTES}),
        ${at}::timestamptz)
      ORDER BY due_at, bot_id, kind, event_id
      LIMIT ${RUN_MAX + 1}`;
    const batch = rows
      .slice(0, RUN_MAX)
      .sort(
        (a, b) =>
          Number(a.bot_id) - Number(b.bot_id) ||
          a.kind.localeCompare(b.kind) ||
          Number(a.event_id) - Number(b.event_id),
      );
    const out = { locked: false, ...none, more: rows.length > RUN_MAX };
    const limits = await antiAbuse(tx);
    const cap = eventFireRules(limits);
    for (const r of batch) {
      let outcome: "fired" | "skipped" | "missed";
      let reason: SkipReason | null = null;
      // An item that couldn't have fired says why, even once its window
      // closed: a frozen bot's time wasn't missed, it was skipped.
      if (r.skip) {
        outcome = "skipped";
        reason = r.skip;
      } else if (r.closes_at.getTime() <= at.getTime()) outcome = "missed";
      else if (await tryUse(tx, cap)) outcome = "fired";
      else {
        outcome = "skipped";
        reason = "cap";
      }
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO event_fires (kind, event_id, occurrence, bot_id, due_at, outcome, reason)
        VALUES (${r.kind}, ${r.event_id}, ${r.occurrence}, ${r.bot_id},
                ${r.due_at}, ${outcome}, ${reason})
        ON CONFLICT (kind, event_id, occurrence, bot_id) DO NOTHING
        RETURNING id`;
      if (!row) continue;
      await logAction(tx, {
        action:
          outcome === "fired"
            ? "event.fire"
            : outcome === "skipped"
              ? "event.skipped"
              : "event.missed",
        botId: Number(r.bot_id),
        keyId: null,
        subject: `${r.kind}:${r.event_id}`,
        ipHash: null,
        detail: {
          due_at: r.due_at.toISOString(),
          ...(reason ? { reason } : {}),
        },
      });
      if (outcome === "fired") out.fired += 1;
      else if (outcome === "missed") out.missed += 1;
      else {
        out.skipped += 1;
        if (reason === "cap") out.capped += 1;
      }
    }
    if (out.capped > 0) await noticeEventCap(tx, out.capped);
    return out;
  });
}

type ViewRow = {
  kind: DueKind;
  event_id: string;
  occurrence: number;
  due_at: Date;
  state: DueItem["state"];
};

function itemOf(r: ViewRow): DueItem {
  return {
    kind: r.kind,
    event: Number(r.event_id),
    occurrence: r.occurrence,
    at: r.due_at,
    state: r.state,
  };
}

// The caller's own items: the newest that came due in the last day, then
// the soonest coming. Only what it can still read: a hidden post or
// gathering, or one whose announcer is frozen, never shows. A cap's skip
// shows as missed; other skips were the bot's own state or a moderator's
// act and aren't shown. An item past due with no row yet is coming while
// its window is open (the next run fires it) and missed after.
export async function dueFor(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<DueItem[]> {
  const past = await sql<ViewRow[]>`
    SELECT kind, event_id, occurrence, due_at, state FROM (
      SELECT f.kind, f.event_id, f.occurrence, f.due_at,
        CASE WHEN f.outcome = 'fired' THEN 'fired' ELSE 'missed' END AS state
      FROM event_fires f
      WHERE f.bot_id = ${botId} AND f.due_at > now() - interval '1 day'
        AND (f.outcome <> 'skipped' OR f.reason = 'cap')
        AND CASE f.kind
          WHEN 'back' THEN EXISTS (SELECT 1 FROM posts p
                                   WHERE p.id = f.event_id AND post_is_visible(p))
          ELSE EXISTS (SELECT 1 FROM gatherings g
                       WHERE g.id = f.event_id AND gathering_is_visible(g))
        END
      UNION ALL
      SELECT d.kind, d.event_id, d.occurrence, d.due_at, 'missed'
      FROM due_items(now() - interval '1 day', now(), ${botId}) d
      WHERE d.skip IS NULL AND d.closes_at <= now()
    ) x
    ORDER BY due_at DESC, kind, event_id
    LIMIT ${DUE_PAST_MAX}`;
  const coming = await comingFor(sql, botId, DUE_COMING_MAX);
  return [...past.reverse().map(itemOf), ...coming.map(itemOf)];
}

async function comingFor(
  sql: postgres.Sql | Tx,
  botId: number,
  limit: number,
): Promise<ViewRow[]> {
  return sql<ViewRow[]>`
    SELECT d.kind, d.event_id, d.occurrence, d.due_at, 'coming' AS state
    FROM due_items(now() - make_interval(mins => ${RUN_LOOKBACK_MINUTES}), 'infinity', ${botId}) d
    WHERE d.skip IS NULL AND d.closes_at > now()
    ORDER BY d.due_at, d.kind, d.event_id
    LIMIT ${limit}`;
}
