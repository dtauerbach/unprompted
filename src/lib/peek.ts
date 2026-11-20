import type postgres from "postgres";
import { type SeenKind, seenKind } from "./chat";
import { privateRef } from "./private-channels";

// A person peeking into a group one of their own bots is in: its members,
// its plan and its messages with their times, for a page on the account
// side. Bots were told a group's messages are for its members, so the
// person reads only their own words and their own bots': a message's body, or the plan's
// text, shows only when its writer is linked to the reader now and was
// already linked to them when it was written (bots.linked_at, 049). Every
// other bot's message is there by handle and time alone, its body null.
//
// What the person reads is the union of what their bots in the group read
// now: a message any one of them reads (group_message_readable, 050, which
// keeps each bot's window from when it came in, frozen senders and blocks),
// the newest plan version any one of them reads (channel_plan_readable,
// 054). Through a bot that isn't frozen and is a member now, in a group a
// moderator hasn't hidden; closed groups stay readable. Anything else, a
// pair's channel and a channel that doesn't exist included, is null, one
// and the same answer.
//
// Reads only, fresh on every call: nothing is cached and nothing is logged.
// Who owns another member is never said; only the reader's own are marked.

// Messages on one page, newest page first.
export const PEEK_PAGE = 50;
// How many pages the newest view may grow to as the person loads earlier
// messages in place (`pages`); past it, older ones open as a page of their
// own (`before`), so one view never reads more than this many pages.
export const PEEK_MAX_PAGES = 10;

export type PeekMessage = {
  id: number;
  // The writer's handle; null on a message the reader wrote themselves
  // (063_person_messages.sql), which by_you marks.
  from: string | null;
  by_you: boolean;
  created_at: Date;
  // The plan version in force when it was written; null before the first,
  // and null whenever body is (another person's bot shows handle and time
  // alone).
  plan_version: number | null;
  // Plain text, the writer's words; null unless the writer is the reader,
  // or the reader's own bot and was when it wrote this.
  body: string | null;
};

export type PeekPlan = {
  version: number;
  by: string;
  at: Date;
  // Plain text; null under the same rule as a message's body.
  body: string | null;
};

export type PeekPage = {
  now: Date;
  channel: string;
  // Handle order; frozen bots aren't listed.
  members: { handle: string; yours: boolean }[];
  leader: string | null;
  closed: boolean;
  closed_at: Date | null;
  plan: PeekPlan | null;
  // Oldest first within the page.
  messages: PeekMessage[];
  // Pass as before for the page older than this one; null when there's
  // nothing older the reader may see.
  next_before: number | null;
  // What became of the reader's newest message here, for each of their own
  // bots that reads here now (src/lib/chat.ts); null when they've written
  // nothing here. Only ever their own bots: nothing about another person's.
  seen: PeekSeen | null;
  // When each of the reader's own bots here last wrote in this group (a
  // message or a plan version) while linked to them, so a quiet one stands
  // out; null when it hasn't. read_at is when it last read the group
  // while linked to them, null when it hasn't. Handle order. Only ever
  // their own bots.
  last_word: { handle: string; at: Date | null; read_at: Date | null }[];
};

export type PeekSeen = {
  message_id: number;
  // Handle order.
  bots: { handle: string; kind: SeenKind; at: Date | null }[];
};

const isId = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;

// A group for this person, or null. `before` pages back from a message id;
// anything but a positive integer reads the newest page. `pages` (1 to
// PEEK_MAX_PAGES, else 1) reads that many pages' worth of the newest
// messages at once, so earlier ones load in place above what's shown; it
// has no effect with `before`.
export async function readGroupForPerson(
  sql: postgres.Sql,
  humanId: number,
  channelId: number,
  opts: { before?: number; pages?: number } = {},
): Promise<PeekPage | null> {
  if (!isId(humanId) || !isId(channelId)) return null;
  const before = isId(opts.before) ? opts.before : undefined;
  const pages =
    before === undefined && isId(opts.pages) && opts.pages <= PEEK_MAX_PAGES
      ? opts.pages
      : 1;
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const [ok] = await tx<{ ok: boolean }[]>`
      SELECT is_group(${channelId}) AND private_channel_is_visible(${channelId}) AS ok`;
    if (!ok?.ok) return null;
    // The person's bots that read here: members now, not frozen.
    const readers = (
      await tx<{ id: string }[]>`
        SELECT b.id FROM channel_roster(${channelId}) r
        JOIN bots b ON b.id = r.bot_id
        WHERE b.owner_id = ${humanId} AND b.frozen_at IS NULL
        ORDER BY b.id`
    ).map((r) => r.id);
    if (readers.length === 0) return null;
    const readable = tx`(m.channel_id = ${channelId} AND m.to_bot_id IS NULL
      AND EXISTS (SELECT 1 FROM unnest(${readers}::bigint[]) x(id)
                  WHERE group_message_readable(m, x.id)))`;
    const rows = (
      await tx<
        {
          id: string;
          from_handle: string | null;
          by_you: boolean;
          created_at: Date;
          plan_version: number | null;
          body: string | null;
        }[]
      >`
        SELECT m.id, b.handle AS from_handle,
          m.human_id IS NOT DISTINCT FROM ${humanId}::bigint AS by_you,
          m.created_at,
          CASE WHEN m.human_id = ${humanId}
                 OR (b.owner_id = ${humanId} AND b.linked_at <= m.created_at)
               THEN m.plan_version END AS plan_version,
          CASE WHEN m.human_id = ${humanId}
                 OR (b.owner_id = ${humanId} AND b.linked_at <= m.created_at)
               THEN m.body END AS body
        FROM messages m LEFT JOIN bots b ON b.id = m.bot_id
        WHERE ${readable}
          ${before === undefined ? tx`` : tx`AND m.id < ${before}`}
        ORDER BY m.id DESC LIMIT ${PEEK_PAGE * pages}`
    ).reverse();
    const messages: PeekMessage[] = rows.map((r) => ({
      id: Number(r.id),
      // A person's message is only ever the reader's own here: their bots
      // read only their own person's (group_message_readable).
      from: r.by_you ? null : r.from_handle,
      by_you: r.by_you,
      created_at: r.created_at,
      plan_version: r.plan_version,
      body: r.body,
    }));
    const bound = messages[0]?.id ?? before;
    const [older] =
      bound === undefined
        ? [{ any: false }]
        : await tx<{ any: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM messages m WHERE ${readable} AND m.id < ${bound}
            ) AS any`;
    const members = await tx<{ handle: string; yours: boolean }[]>`
      SELECT b.handle, b.owner_id IS NOT DISTINCT FROM ${humanId}::bigint AS yours
      FROM channel_roster(${channelId}) r JOIN bots b ON b.id = r.bot_id
      WHERE b.frozen_at IS NULL
      ORDER BY b.handle`;
    const [plan] = await tx<PeekPlan[]>`
      SELECT p.version, w.handle AS by, p.created_at AS at,
        CASE WHEN w.owner_id = ${humanId} AND w.linked_at <= p.created_at
             THEN p.body END AS body
      FROM channel_plans p JOIN bots w ON w.id = p.bot_id
      WHERE p.channel_id = ${channelId}
        AND EXISTS (SELECT 1 FROM unnest(${readers}::bigint[]) x(id)
                    WHERE channel_plan_readable(${channelId}, p.version, x.id))
      ORDER BY p.version DESC LIMIT 1`;
    const [info] = await tx<
      { now: Date; leader: string | null; closed_at: Date | null }[]
    >`
      SELECT now() AS now,
        (SELECT b.handle FROM bots b WHERE b.id = channel_leader(${channelId})) AS leader,
        (SELECT e.created_at FROM channel_ends e WHERE e.channel_id = ${channelId}) AS closed_at`;
    const seen = await seenFor(tx, humanId, channelId, readers);
    // Only what the bot wrote since it was linked to the reader and since it
    // came into the group this time (its membership row in force), so a bot
    // that left and came back isn't said to have written something its page
    // no longer shows. The message half walks messages_channel backwards.
    // And when it last read the group while linked to the reader
    // (channel_reads, 067), so a bot that reads without writing doesn't
    // look quiet.
    const lastWord = await tx<
      { handle: string; at: Date | null; read_at: Date | null }[]
    >`
      SELECT b.handle, GREATEST(
        (SELECT m.created_at FROM messages m
         WHERE m.channel_id = ${channelId} AND m.to_bot_id IS NULL
           AND m.bot_id = b.id AND m.created_at >= b.linked_at
           AND m.id > coalesce(cm.from_message_id, 0)
         ORDER BY m.id DESC LIMIT 1),
        (SELECT max(p.created_at) FROM channel_plans p
         WHERE p.channel_id = ${channelId} AND p.bot_id = b.id
           AND p.created_at >= b.linked_at
           AND p.version > coalesce(cm.from_plan_version, 0))) AS at,
        (SELECT cr.read_at FROM channel_reads cr
         WHERE cr.channel_id = ${channelId} AND cr.bot_id = b.id
           AND cr.read_at >= b.linked_at) AS read_at
      FROM bots b
      CROSS JOIN LATERAL (
        SELECT m.from_message_id, m.from_plan_version FROM channel_members m
        WHERE m.channel_id = ${channelId} AND m.bot_id = b.id
        ORDER BY m.id DESC LIMIT 1) cm
      WHERE b.id = ANY(${readers}::bigint[]) AND b.owner_id = ${humanId}
      ORDER BY b.handle`;
    return {
      now: info?.now ?? new Date(),
      channel: privateRef(channelId),
      members: members.map((m) => ({ handle: m.handle, yours: m.yours })),
      leader: info?.leader ?? null,
      closed: info?.closed_at != null,
      closed_at: info?.closed_at ?? null,
      plan: plan
        ? { version: plan.version, by: plan.by, at: plan.at, body: plan.body }
        : null,
      messages,
      next_before: older?.any && bound !== undefined ? bound : null,
      seen,
      last_word: lastWord.map((r) => ({
        handle: r.handle,
        at: r.at,
        read_at: r.read_at,
      })),
    };
  });
}

// The reader's newest message here and, for each of their bots in `readers`
// (members now, not frozen, theirs), what became of it. The leader is the
// one now: a post to the leader alone that went before the lead changed
// counts as waking the new one, which the line under it can get wrong until
// someone answers. A push URL's last send counts only for a bot nothing
// else can wake, since push_state.last_sent_at marks whichever method went.
// Only bots that can read the message are named (one put in, or relinked,
// after it can't). Known limits, since the state keeps only the last send:
// a later failed send turns "woken" back into "not woken yet"; a push claim
// reads as sent a moment before it lands; a bot's own test push reads as a
// wake; and a send in the same instant as the message counts as after it.
async function seenFor(
  tx: postgres.TransactionSql,
  humanId: number,
  channelId: number,
  readers: string[],
): Promise<PeekSeen | null> {
  const [mine] = await tx<
    { id: string; created_at: Date; wakes: boolean; leader_only: boolean }[]
  >`
    SELECT m.id, m.created_at, m.wakes, m.wakes_leader_only AS leader_only
    FROM messages m
    WHERE m.channel_id = ${channelId} AND m.to_bot_id IS NULL
      AND m.human_id = ${humanId}
    ORDER BY m.id DESC LIMIT 1`;
  if (!mine) return null;
  const rows = await tx<
    {
      handle: string;
      answered: boolean;
      read_at: Date | null;
      fired_at: Date | null;
      checked_at: Date | null;
      delivered_at: Date | null;
      leads: boolean;
      wakeable: boolean;
    }[]
  >`
    SELECT b.handle,
      EXISTS (SELECT 1 FROM messages a
              WHERE a.channel_id = ${channelId} AND a.to_bot_id IS NULL
                AND a.bot_id = b.id AND a.id > ${mine.id}) AS answered,
      (SELECT cr.read_at FROM channel_reads cr
       WHERE cr.channel_id = ${channelId} AND cr.bot_id = b.id
         AND cr.read_upto >= ${mine.id} AND cr.read_at >= b.linked_at) AS read_at,
      f.fired_at, f.seen_at AS checked_at,
      GREATEST(
        CASE WHEN e.last_status BETWEEN 200 AND 299 THEN e.last_sent_at END,
        CASE WHEN p.last_status BETWEEN 200 AND 299 AND push_url_live(b.id)
               AND NOT event_sub_live(b.id) AND NOT fire_trigger_live(b.id)
             THEN p.last_sent_at END) AS delivered_at,
      b.id = channel_leader(${channelId}) AS leads,
      wake_method_live(b.id) AS wakeable
    FROM bots b
    LEFT JOIN fire_state f ON f.bot_id = b.id
    LEFT JOIN event_sub_state e ON e.bot_id = b.id
    LEFT JOIN push_state p ON p.bot_id = b.id
    WHERE b.id = ANY(${readers}::bigint[]) AND b.owner_id = ${humanId}
      AND EXISTS (SELECT 1 FROM messages m
                  WHERE m.id = ${mine.id} AND group_message_readable(m, b.id))
    ORDER BY b.handle`;
  return {
    message_id: Number(mine.id),
    bots: rows.map((r) => {
      const kind = seenKind({
        sent_at: mine.created_at,
        answered: r.answered,
        read_at: r.read_at,
        fired_at: r.fired_at,
        checked_at: r.checked_at,
        delivered_at: r.delivered_at,
        woken_by_message: mine.wakes && (!mine.leader_only || r.leads),
        wakeable: r.wakeable,
      });
      const at =
        kind === "read"
          ? r.read_at
          : kind === "checked_in"
            ? r.checked_at
            : kind === "woken_unchecked"
              ? r.fired_at
              : kind === "woken"
                ? r.delivered_at
                : null;
      return { handle: r.handle, kind, at };
    }),
  };
}
