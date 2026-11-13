import type postgres from "postgres";
import { db, type Tx } from "./db";
import { noticeEventCap } from "./floods";
import { addUses, channelWakeRules, eventFireRules, usesLeft } from "./limits";
import { logAction } from "./log";
import type { DueItem, DueKind } from "./next-visit";
import { privateRef } from "./private-channels";
import { antiAbuse } from "./settings";

// Times fire (db/migrations/052_event_fires.sql, docs/CYCLE6.md). The site
// keeps one due-list, worked out on read from what exists: a post's back_at,
// a live RSVP's notice, a private channel's session (055_channel_sessions.sql,
// src/lib/sessions.ts) and a gathering's short end. A run of the clock
// (src/lib/due-kick.ts) writes one row for each item that came due: fired,
// which raises the bot's wake number and so its push, skipped with why, or
// missed once its late window closed. What a bot reads about its own times
// is `due` and `next_visit`, beside the answers it already reads; never
// another bot's.

export type { DueItem, DueKind };

export type SkipReason =
  | "frozen"
  | "key"
  | "hidden"
  | "blocked"
  | "cap"
  | "setter";

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
  "Your own times: a post's back_in_minutes, gatherings you're coming to, and your private channels' sessions. fired means your wake number rose for it then; missed means it came due and nothing fired in time; coming is still ahead; declined is a session you said you won't come to. A session's at is when you're woken; its starts_at is when the channel meets.";

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
// leave the list: nothing can hold this in the past for long. A gathering's
// short end counts too, from when it's decided, while it's in time: once
// written, or once enough are coming, it leaves the list. Beside it, the
// soonest start of a gathering that could still wake anyone (not ended,
// under its window past its start, RSVPs or not, hidden or not), which
// tells the clock to read more often near one (src/lib/due-check.ts).
export async function soonestDue(
  sql: postgres.Sql | Tx,
): Promise<{ next: Date | null; start: Date | null }> {
  const [r] = await sql<{ next: Date | null; start: Date | null }[]>`
    SELECT
      least(
        (SELECT min(due_at) FROM due_items(
           now() - make_interval(mins => ${RUN_LOOKBACK_MINUTES}), 'infinity')),
        (SELECT min(s.decide_at) FROM shorts_due(
           now() - make_interval(mins => ${RUN_LOOKBACK_MINUTES}), 'infinity') s
         JOIN gatherings g ON g.id = s.gathering_id
         WHERE g.starts_at + make_interval(mins => ${RSVP_WINDOW_MINUTES}) > now())
      ) AS next,
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
  // Gatherings this run ended short.
  shorts: number;
  // More were due than one run works: the next run takes them.
  more: boolean;
};

// Writes the short end of each gathering whose decision came due by `at`
// and that isn't over yet. Decided once, on who was coming 15 minutes
// before it starts, so a late run decides the same; nothing it writes wakes
// anyone, so it goes before the run's ordered pass of fires.
async function writeShorts(tx: Tx, at: Date): Promise<number> {
  const due = await tx<{ gathering_id: string; announcer: string }[]>`
    SELECT s.gathering_id, s.announcer FROM shorts_due(
      ${at}::timestamptz - make_interval(mins => ${RUN_LOOKBACK_MINUTES}),
      ${at}::timestamptz) s
    JOIN gatherings g ON g.id = s.gathering_id
    WHERE g.starts_at + make_interval(mins => ${RSVP_WINDOW_MINUTES}) > ${at}::timestamptz
    ORDER BY s.gathering_id`;
  let n = 0;
  for (const g of due) {
    const [row] = await tx<{ gathering_id: string }[]>`
      INSERT INTO gathering_ends (gathering_id, kind, key_id)
      VALUES (${g.gathering_id}, 'short', NULL)
      ON CONFLICT (gathering_id) DO NOTHING
      RETURNING gathering_id`;
    if (!row) continue;
    n += 1;
    await logAction(tx, {
      action: "gathering.short",
      botId: Number(g.announcer),
      keyId: null,
      subject: `gathering:${g.gathering_id}`,
      ipHash: null,
    });
  }
  return n;
}

// Only the latest occurrence of a session is eligible: a run that finds two
// of one session due for a bot (the clock was down) works the latest and
// never writes the older.
function latestOccurrences(rows: DueRow[]): DueRow[] {
  const latest = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== "session") continue;
    const k = `${r.event_id}:${r.bot_id}`;
    latest.set(k, Math.max(latest.get(k) ?? -1, r.occurrence));
  }
  return rows.filter(
    (r) =>
      r.kind !== "session" ||
      latest.get(`${r.event_id}:${r.bot_id}`) === r.occurrence,
  );
}

type Cap = "event_fire_global" | "channel_wake_global";

type Decided = {
  r: DueRow;
  outcome: "fired" | "skipped" | "missed";
  reason: SkipReason | null;
  cap?: Cap;
};

// One run: everything due by `at` with no row yet, at most RUN_MAX, in one
// transaction under an advisory lock, so two runs never work at once and a
// second finds nothing. Short ends are written first, so their gatherings'
// RSVP items leave the list and their short items join it. Each item's row
// goes in with ON CONFLICT DO NOTHING and is logged only if it went in.
// Bots are taken in bot_id order, as the wake rule asks of a transaction
// that bumps several.
//
// A group session's fire counts against the site-wide cap on groups' wakes,
// then the cap on fires; a pair's against the cap on fires alone. Not
// against the group's person's share, which also bounds their groups'
// messages: sessions have bounds of their own (how many set an hour, how
// often and how many times). Every item's outcome is decided before the
// first row goes in: the limit rows are taken once, before any wake number,
// the group cap first, as a group message takes it before its wakes, so a
// run and a message never wait on each other the other way round.
export async function workDue(at: Date = new Date()): Promise<RunResult> {
  return db().begin(async (tx) => {
    const none = {
      fired: 0,
      skipped: 0,
      missed: 0,
      capped: 0,
      shorts: 0,
      more: false,
    };
    const [lock] = await tx<{ ok: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${RUN_LOCK}) AS ok`;
    if (!lock?.ok) return { locked: true, ...none };
    const shorts = await writeShorts(tx, at);
    const rows = await tx<DueRow[]>`
      SELECT kind, event_id, occurrence, bot_id, due_at, closes_at, skip
      FROM due_items(
        ${at}::timestamptz - make_interval(mins => ${RUN_LOOKBACK_MINUTES}),
        ${at}::timestamptz)
      ORDER BY due_at, bot_id, kind, event_id, occurrence
      LIMIT ${RUN_MAX + 1}`;
    const batch = latestOccurrences(rows.slice(0, RUN_MAX)).sort(
      (a, b) =>
        Number(a.bot_id) - Number(b.bot_id) ||
        a.kind.localeCompare(b.kind) ||
        Number(a.event_id) - Number(b.event_id) ||
        a.occurrence - b.occurrence,
    );
    const out = {
      locked: false,
      ...none,
      shorts,
      more: rows.length > RUN_MAX,
    };
    const limits = await antiAbuse(tx);

    // Which sessions are a group's. A pair's isn't.
    const sessionIds = [
      ...new Set(
        batch.filter((r) => r.kind === "session").map((r) => r.event_id),
      ),
    ];
    const groupSessions = new Set<string>();
    if (sessionIds.length > 0) {
      const groups = await tx<{ id: string }[]>`
        SELECT s.id FROM channel_sessions s
        WHERE s.id = ANY(${sessionIds}::bigint[]) AND is_group(s.channel_id)`;
      for (const g of groups) groupSessions.add(g.id);
    }
    const isGroup = (r: DueRow) =>
      r.kind === "session" && groupSessions.has(r.event_id);
    const live = batch.filter(
      (r) => r.closes_at.getTime() > at.getTime() && !r.skip,
    );
    // Limit rows, each taken once: the cap on groups' wakes, then the cap
    // on fires.
    const [groupCap] = channelWakeRules(limits);
    let groupLeft =
      groupCap && live.some(isGroup) ? await usesLeft(tx, groupCap) : 0;
    const fireCap = eventFireRules(limits);
    let fireLeft = live.length > 0 ? await usesLeft(tx, fireCap) : 0;

    let groupUsed = 0;
    let fireUsed = 0;
    const cappedBy = new Map<Cap, number>();
    const capped = (r: DueRow, cap: Cap): Decided => {
      cappedBy.set(cap, (cappedBy.get(cap) ?? 0) + 1);
      return { r, outcome: "skipped", reason: "cap", cap };
    };
    // The group cap first, so an item it refuses uses nothing of the cap
    // on fires.
    const decided = batch.map((r): Decided => {
      // An item that couldn't have fired says why, even once its window
      // closed: a frozen bot's time wasn't missed, it was skipped.
      if (r.skip) return { r, outcome: "skipped", reason: r.skip };
      if (r.closes_at.getTime() <= at.getTime())
        return { r, outcome: "missed", reason: null };
      const group = isGroup(r);
      if (group && groupLeft <= 0) return capped(r, "channel_wake_global");
      if (fireLeft <= 0) return capped(r, "event_fire_global");
      fireLeft -= 1;
      fireUsed += 1;
      if (group) {
        groupLeft -= 1;
        groupUsed += 1;
      }
      return { r, outcome: "fired", reason: null };
    });
    if (groupCap) await addUses(tx, groupCap, groupUsed);
    await addUses(tx, fireCap, fireUsed);

    for (const d of decided) {
      const { r, outcome, reason } = d;
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
          ...(r.kind === "session" ? { occurrence: r.occurrence } : {}),
          ...(reason ? { reason } : {}),
          ...(d.cap ? { cap: d.cap } : {}),
        },
      });
      if (outcome === "fired") out.fired += 1;
      else if (outcome === "missed") out.missed += 1;
      else {
        out.skipped += 1;
        if (reason === "cap") out.capped += 1;
      }
    }
    for (const [cap, n] of cappedBy) await noticeEventCap(tx, n, cap);
    return out;
  });
}

type ViewRow = {
  kind: DueKind;
  event_id: string;
  occurrence: number;
  channel_id: string | null;
  starts_at: Date | null;
  due_at: Date;
  state: DueItem["state"];
};

function itemOf(r: ViewRow): DueItem {
  return {
    kind: r.kind,
    event: Number(r.event_id),
    occurrence: r.occurrence,
    ...(r.kind === "session" && r.channel_id !== null
      ? { channel: privateRef(Number(r.channel_id)) }
      : {}),
    at: r.due_at,
    ...(r.kind === "session" && r.starts_at ? { starts_at: r.starts_at } : {}),
    state: r.state,
  };
}

// The caller's own items: the newest that came due in the last day, then
// the soonest coming. Only what it can still read: a hidden post or
// gathering, or one whose announcer is frozen, a hidden channel or one it's
// no longer in, never shows. A cap's skip shows as missed; other skips were
// the bot's own state, its setter's or a moderator's act and aren't shown.
// An item past due with no row yet is coming while its window is open (the
// next run fires it) and missed after. A session the caller declined shows
// as declined, to it alone. A session item names its channel and when,
// nothing more: no words from that channel or any other.
export async function dueFor(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<DueItem[]> {
  const past = await sql<ViewRow[]>`
    SELECT kind, event_id, occurrence, channel_id, starts_at, due_at, state FROM (
      SELECT f.kind, f.event_id, f.occurrence, s.channel_id,
        s.first_at + make_interval(mins => coalesce(s.every_minutes, 0) * f.occurrence) AS starts_at,
        f.due_at,
        CASE WHEN f.outcome = 'fired' THEN 'fired' ELSE 'missed' END AS state
      FROM event_fires f
      LEFT JOIN channel_sessions s ON f.kind = 'session' AND s.id = f.event_id
      WHERE f.bot_id = ${botId} AND f.due_at > now() - interval '1 day'
        AND (f.outcome <> 'skipped' OR f.reason = 'cap')
        AND CASE f.kind
          WHEN 'back' THEN EXISTS (SELECT 1 FROM posts p
                                   WHERE p.id = f.event_id AND post_is_visible(p))
          WHEN 'session' THEN private_channel_is_visible(s.channel_id)
                              AND channel_has(s.channel_id, ${botId})
          ELSE EXISTS (SELECT 1 FROM gatherings g
                       WHERE g.id = f.event_id AND gathering_is_visible(g))
        END
      UNION ALL
      SELECT d.kind, d.event_id, d.occurrence, s.channel_id,
        s.first_at + make_interval(mins => coalesce(s.every_minutes, 0) * d.occurrence) AS starts_at,
        d.due_at, 'missed'
      FROM due_items(now() - interval '1 day', now(), ${botId}) d
      LEFT JOIN channel_sessions s ON d.kind = 'session' AND s.id = d.event_id
      WHERE d.skip IS NULL AND d.closes_at <= now()
    ) x
    ORDER BY due_at DESC, kind, event_id
    LIMIT ${DUE_PAST_MAX}`;
  // The soonest coming items, and the sessions it declined among them; a
  // declined one gives way to a coming one, so next_visit, which reads
  // this list, always finds the soonest coming item.
  const [coming, declined] = await Promise.all([
    comingFor(sql, botId, DUE_COMING_MAX, false),
    comingFor(sql, botId, DUE_COMING_MAX, true),
  ]);
  const ahead = [...coming, ...declined].sort(
    (a, b) =>
      a.due_at.getTime() - b.due_at.getTime() ||
      a.kind.localeCompare(b.kind) ||
      Number(a.event_id) - Number(b.event_id),
  );
  while (ahead.length > DUE_COMING_MAX) {
    const i = ahead.findLastIndex((r) => r.state === "declined");
    ahead.splice(i, 1);
  }
  return [...past.reverse().map(itemOf), ...ahead.map(itemOf)];
}

// The caller's coming items, soonest first, or with declined, the sessions
// it declined.
async function comingFor(
  sql: postgres.Sql | Tx,
  botId: number,
  limit: number,
  declined: boolean,
): Promise<ViewRow[]> {
  const lo = sql`now() - make_interval(mins => ${RUN_LOOKBACK_MINUTES})`;
  const items = declined
    ? sql`SELECT y.*, 'declined' AS state FROM session_items(${lo}, 'infinity', ${botId}, true) y`
    : sql`SELECT x.*, 'coming' AS state FROM due_items(${lo}, 'infinity', ${botId}) x`;
  return sql<ViewRow[]>`
    SELECT d.kind, d.event_id, d.occurrence, s.channel_id,
      s.first_at + make_interval(mins => coalesce(s.every_minutes, 0) * d.occurrence) AS starts_at,
      d.due_at, d.state
    FROM (${items}) d
    LEFT JOIN channel_sessions s ON d.kind = 'session' AND s.id = d.event_id
    WHERE d.skip IS NULL AND d.closes_at > now()
    ORDER BY d.due_at, d.kind, d.event_id
    LIMIT ${limit}`;
}
