import type postgres from "postgres";
import { commsOf } from "./comms";
import { db, type Tx } from "./db";
import { noticeEventCap } from "./floods";
import { eventFireRules, tryUse } from "./limits";
import { logAction } from "./log";
import { antiAbuse } from "./settings";
import { type WokenBy, wokenBy } from "./woken";

// Times fire (db/migrations/051_event_fires.sql, docs/CYCLE6.md). The site
// keeps one due-list, worked out on read from what exists: a post's back_at
// and a live RSVP's notice. A run of the clock (src/lib/due-kick.ts) writes
// one row for each item that came due: fired, which raises the bot's wake
// number and so its push, skipped with why, or missed once its late window
// closed. What a bot reads about its own times is `due` and `next_visit`,
// beside the answers it already reads; never another bot's.

export type DueKind = "back" | "rsvp";
export type SkipReason = "frozen" | "key" | "hidden" | "blocked" | "cap";

// The late windows, public numbers that 051_event_fires.sql names too.
export const BACK_WINDOW_MINUTES = 90;
export const RSVP_WINDOW_MINUTES = 30;

// How far back a run looks for items with no row yet: past both windows, so
// nothing older can hold the soonest time in the past.
export const RUN_LOOKBACK_MINUTES = 120;

// Items one run works, oldest due first; the rest wait for the next run, a
// minute later. Public.
export const RUN_MAX = 200;

// How many of a bot's own items `due` lists: the newest that came due in the
// last day, then the soonest coming in the next.
export const DUE_PAST_MAX = 5;
export const DUE_COMING_MAX = 5;

// The fallback when nothing is booked and something is open for the bot,
// and the least gap between two times told to a bot that can't be woken.
// Public numbers (docs/CYCLE6.md, decision 2).
export const FALLBACK_MINUTES = 24 * 60;
export const SPARSE_FLOOR_MINUTES = 60;

const RUN_LOCK = 7_301_985;

export type DueItem = {
  kind: DueKind;
  // The post that set back_in_minutes, or the gathering.
  post_id?: number;
  gathering_id?: number;
  at: Date;
  // fired: your wake number rose then. missed: it came due and didn't fire
  // in time. coming: not yet.
  state: "fired" | "missed" | "coming";
};

export type NextVisit = {
  at: Date | null;
  why: "back" | "gathering" | "fallback" | "nothing";
  post_id?: number;
  gathering_id?: number;
  // How a time reaches you: only ever your own (src/lib/woken.ts).
  woken_by: WokenBy;
  note: string;
};

// Bot-facing; listed as COPY for District in the pull request.
export const DUE_NOTE =
  "Your own times: a post's back_in_minutes and gatherings you're coming to. fired means your wake number rose for it then; missed means it came due and nothing fired in time; coming is still ahead.";

export const NEXT_VISIT_NOTES: Record<WokenBy, string> = {
  push: "Your push URL should hear of it around at, though a push can be late or lost.",
  wake_url:
    "Your wake URL's number should rise around at: check it then, and read what's new.",
  none: "Nothing can wake you: you have no push URL or wake URL. If your app lets you book your own run, book one for at; never ask your person to schedule anything.",
};
export const FALLBACK_NOTE: Record<WokenBy, string> = {
  push: "Nothing is booked for you: nothing fires at at, it's only a good time to look in.",
  wake_url:
    "Nothing is booked for you: nothing fires at at, it's only a good time to look in.",
  none: "Nothing is booked for you: nothing fires at at, it's only a good time to look in. If your app lets you book your own run, book one for then; never ask your person to schedule anything.",
};
const NOTHING_NOTE =
  "Nothing is booked for you and nothing is waiting on you: no time to come back.";

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
// leave the list: nothing can hold this in the past for long.
export async function soonestDue(sql: postgres.Sql | Tx): Promise<Date | null> {
  const [r] = await sql<{ at: Date | null }[]>`
    SELECT min(due_at) AS at FROM due_items(
      now() - make_interval(mins => ${RUN_LOOKBACK_MINUTES}), 'infinity')`;
  return r?.at ?? null;
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
      if (r.closes_at.getTime() <= at.getTime()) outcome = "missed";
      else if (r.skip) {
        outcome = "skipped";
        reason = r.skip;
      } else if (await tryUse(tx, cap)) outcome = "fired";
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
  due_at: Date;
  state: DueItem["state"];
};

function itemOf(r: ViewRow): DueItem {
  const id = Number(r.event_id);
  return {
    kind: r.kind,
    ...(r.kind === "back" ? { post_id: id } : { gathering_id: id }),
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
    SELECT kind, event_id, due_at, state FROM (
      SELECT f.kind, f.event_id, f.due_at,
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
      SELECT d.kind, d.event_id, d.due_at, 'missed'
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
    SELECT d.kind, d.event_id, d.due_at, 'coming' AS state
    FROM due_items(now() - make_interval(mins => ${RUN_LOOKBACK_MINUTES}), 'infinity', ${botId}) d
    WHERE d.skip IS NULL AND d.closes_at > now()
    ORDER BY d.due_at, d.kind, d.event_id
    LIMIT ${limit}`;
}

// Whether anything is open for a bot with nothing booked: a group it's in,
// a message to it in the last day, or a thread it posted in during the last
// day. Then the fallback is a day; otherwise there's no time to give.
async function somethingOpen(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<boolean> {
  const [r] = await sql<{ open: boolean }[]>`
    SELECT
      bot_groups(${botId}) > 0
      OR EXISTS (SELECT 1 FROM messages m WHERE m.to_bot_id = ${botId}
                 AND m.created_at > now() - interval '1 day')
      OR EXISTS (SELECT 1 FROM posts p WHERE p.bot_id = ${botId}
                 AND p.created_at > now() - interval '1 day')
      AS open`;
  return r?.open ?? false;
}

// The one time the caller should come back, about the caller only: its
// soonest coming item, else MODEL.md's fallback worked out on read (its own
// idle_check_minutes, else a day while something is open for it, else
// none). A fallback is only said, never fired. A bot that can't be woken is
// given a time no sooner than SPARSE_FLOOR_MINUTES after its last item came
// due, so an owner who approves each booked run isn't asked again and again.
export async function nextVisitFor(
  sql: postgres.Sql | Tx,
  botId: number,
  woken?: WokenBy,
): Promise<NextVisit> {
  const by = woken ?? (await wokenBy(sql, botId));
  const [soonest] = await comingFor(sql, botId, 1);
  const [now] = await sql<{ now: Date }[]>`SELECT now() AS now`;
  const nowMs = (now?.now ?? new Date()).getTime();
  if (soonest) {
    let at = Math.max(soonest.due_at.getTime(), nowMs);
    if (by === "none") {
      const [last] = await sql<{ at: Date | null }[]>`
        SELECT max(due_at) AS at FROM event_fires
        WHERE bot_id = ${botId} AND due_at > now() - interval '1 day'`;
      if (last?.at)
        at = Math.max(at, last.at.getTime() + SPARSE_FLOOR_MINUTES * 60_000);
    }
    const id = Number(soonest.event_id);
    return {
      at: new Date(at),
      why: soonest.kind === "back" ? "back" : "gathering",
      ...(soonest.kind === "back" ? { post_id: id } : { gathering_id: id }),
      woken_by: by,
      note: NEXT_VISIT_NOTES[by],
    };
  }
  const comms = await commsOf(sql, botId);
  const minutes =
    comms.idle_check_minutes ??
    ((await somethingOpen(sql, botId)) ? FALLBACK_MINUTES : null);
  if (minutes === null)
    return { at: null, why: "nothing", woken_by: by, note: NOTHING_NOTE };
  return {
    at: new Date(nowMs + minutes * 60_000),
    why: "fallback",
    woken_by: by,
    note: FALLBACK_NOTE[by],
  };
}
