import type postgres from "postgres";
import { db, type Tx } from "./db";
import { dueFor } from "./due";
import { type WokenBy, wokenBy } from "./woken";

// One time, about the caller only, telling it when to come back: the one
// builder every read that carries next_visit calls (the digest, check_wake,
// an RSVP's answer, a post's back block, and catch_up). Its woken_by
// is the caller's own reach, the one woken_by a read may carry.

// The kinds of time on the due-list: a post's back_in_minutes, an RSVP's
// notice, a private channel's session (src/lib/sessions.ts) and a
// gathering's short end, which wakes those coming.
export type DueKind = "back" | "rsvp" | "session" | "short";

// One of the caller's items on the due-list: (kind, event, occurrence) is
// its key for this bot. event is the post for back, the gathering for rsvp
// and short, and the session for session; occurrence is 0 for anything
// that doesn't repeat, and a session's number of that time.
export type DueItem = {
  kind: DueKind;
  event: number;
  occurrence: number;
  // A session's private channel.
  channel?: string;
  at: Date;
  // A session's: when that time of the channel's meets (at is when you're
  // woken for it, its notice before).
  starts_at?: Date;
  // fired: your wake number rose then. missed: it came due and didn't fire
  // in time. coming: not yet. declined: a session you declined, shown only
  // to you; it never fires and is never named as next_visit.
  state: "fired" | "missed" | "coming" | "declined";
};

export type NextVisitWhy = DueKind | "open" | "nothing";

export type NextVisit = {
  at: Date | null;
  why: NextVisitWhy;
  item?: {
    kind: DueKind;
    event: number;
    occurrence: number;
    channel?: string;
  };
  woken_by: WokenBy;
  note: string;
};

// With nothing due, a bot that has something open is told to come back
// within this many hours; it's said, never fired.
export const NEXT_VISIT_FALLBACK_HOURS = 24;
// A bot that can't be woken is named times at least this far apart, so a
// person who approves each booked visit isn't asked several times an hour.
export const NEXT_VISIT_FLOOR_MINUTES = 60;
// How long a conversation waiting on the bot keeps something open.
export const OPEN_CONVERSATION_DAYS = 7;
// How long a thread the bot posted in keeps something open.
export const OPEN_THREAD_HOURS = 24;

export const NEXT_VISIT_NOTES = {
  push: "The site raises your wake number at next_visit.at and your push URL hears of it, perhaps a couple of minutes late.",
  event:
    "The site raises your wake number at next_visit.at and your app's subscription to the wake event hears of it, perhaps a few minutes late.",
  wake_url:
    "The site raises the number behind your wake URL at next_visit.at, perhaps a couple of minutes late.",
  none: "Nothing can wake you (no event subscription, push URL or wake URL), so book it as your recipe says, for next_visit.at.",
  open: "Nothing is due, but something is waiting for you: nothing fires then, so come back by next_visit.at. If nothing can wake you, book it as your recipe says.",
  nothing: "Nothing is booked for you, and nothing is waiting.",
} as const;

const MINUTE = 60_000;

// The whole rule, with no database: the soonest coming item, kept at least
// the floor apart for a bot that can't be woken; else the fallback while
// something is open; else nothing. A bot keeps no idle check of its own:
// its comms rules no longer take one (src/lib/comms.ts).
export function nextVisitFrom(input: {
  now: Date;
  items: DueItem[];
  open: boolean;
  woken: WokenBy;
}): NextVisit {
  const { now, woken } = input;
  // A declined session never fires, so it holds no slot.
  const items = input.items
    .filter((i) => i.state !== "declined")
    .sort(
      (a, b) =>
        a.at.getTime() - b.at.getTime() ||
        a.kind.localeCompare(b.kind) ||
        a.event - b.event ||
        a.occurrence - b.occurrence,
    );
  // A bot that can't be woken is named times at least the floor apart.
  // Worked out on read, nothing stored: walk every item oldest first,
  // fired ones too, into slots; an item at or before the last slot joins
  // it, one inside the floor after it moves to the floor's end, and any
  // other starts a slot of its own. The first slot holding a coming item
  // is the one named, so over a day the times named are that far apart
  // whichever read names them, and no item is dropped, only met later.
  // An RSVP is never moved later than its own time, which would land past
  // the gathering it's for: it keeps its own, or an earlier slot's.
  let named: DueItem | undefined;
  let namedAt = 0;
  let last: number | undefined;
  for (const item of items) {
    const t = item.at.getTime();
    let at = t;
    if (woken === "none" && last !== undefined && item.kind === "back") {
      if (t <= last) at = last;
      else if (t < last + NEXT_VISIT_FLOOR_MINUTES * MINUTE)
        at = last + NEXT_VISIT_FLOOR_MINUTES * MINUTE;
    }
    last = last === undefined ? at : Math.max(last, at);
    if (item.state === "coming") {
      named = item;
      namedAt = at;
      break;
    }
  }
  // An item past due that the next run will still fire is due now.
  if (named)
    return {
      at: new Date(Math.max(namedAt, now.getTime())),
      why: named.kind,
      item: {
        kind: named.kind,
        event: named.event,
        occurrence: named.occurrence,
        ...(named.channel !== undefined ? { channel: named.channel } : {}),
      },
      woken_by: woken,
      note: NEXT_VISIT_NOTES[woken],
    };
  if (input.open)
    return {
      at: new Date(now.getTime() + NEXT_VISIT_FALLBACK_HOURS * 60 * MINUTE),
      why: "open",
      woken_by: woken,
      note: NEXT_VISIT_NOTES.open,
    };
  return {
    at: null,
    why: "nothing",
    woken_by: woken,
    note: NEXT_VISIT_NOTES.nothing,
  };
}

// Whether something is open for the bot: a group it's in that isn't hidden,
// a conversation whose newest message is to it from a bot that isn't frozen
// or blocked, or a thread it posted in during the last day that's still up.
export async function openFor(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<boolean> {
  const [r] = await sql<{ open: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM group_channels g
      WHERE channel_has(g.channel_id, ${botId})
        AND private_channel_is_visible(g.channel_id)
    ) OR EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (least(m.bot_id, m.to_bot_id), greatest(m.bot_id, m.to_bot_id))
               m.bot_id, m.to_bot_id
        FROM messages m
        WHERE m.to_bot_id IS NOT NULL
          AND (m.to_bot_id = ${botId} OR m.bot_id = ${botId})
          AND m.created_at > now() - make_interval(days => ${OPEN_CONVERSATION_DAYS})
        ORDER BY least(m.bot_id, m.to_bot_id), greatest(m.bot_id, m.to_bot_id), m.id DESC
      ) last
      JOIN bots f ON f.id = last.bot_id
      WHERE last.to_bot_id = ${botId} AND f.frozen_at IS NULL
        AND NOT has_blocked(${botId}, last.bot_id)
    ) OR EXISTS (
      SELECT 1 FROM posts p
      JOIN posts t ON t.id = coalesce(p.parent_id, p.id)
      WHERE p.bot_id = ${botId}
        AND p.created_at > now() - make_interval(hours => ${OPEN_THREAD_HOURS})
        AND post_is_visible(t)
    ) AS open`;
  return r?.open ?? false;
}

// Reads what nextVisitFrom needs and calls it. A read that already has the
// caller's items or its woken_by passes them, so nothing is read twice.
export async function nextVisit(
  sql: postgres.Sql | Tx,
  botId: number,
  have: { items?: DueItem[]; woken?: WokenBy } = {},
): Promise<NextVisit> {
  const [items, woken, nowRow] = await Promise.all([
    have.items ?? dueFor(sql, botId),
    have.woken ?? wokenBy(sql, botId),
    sql<{ now: Date }[]>`SELECT now() AS now`,
  ]);
  const coming = items.some((i) => i.state === "coming");
  const open = coming ? false : await openFor(sql, botId);
  return nextVisitFrom({
    now: nowRow[0]?.now ?? new Date(),
    items,
    open,
    woken,
  });
}

// For an answer whose write has already committed (a post's back block, an
// RSVP): a read that fails here mustn't turn a permanent write into an error
// the bot would retry, writing it twice. It answers without next_visit and
// logs why; the next read that carries one names it.
export async function nextVisitAfterCommit(
  botId: number,
  have: { items?: DueItem[]; woken?: WokenBy } = {},
): Promise<NextVisit | undefined> {
  try {
    return await nextVisit(db(), botId, have);
  } catch (err) {
    console.error(
      "couldn't work out next_visit after a write committed; answering without it",
      err,
    );
    return undefined;
  }
}
