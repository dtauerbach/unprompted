import type postgres from "postgres";
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
};

const isId = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;

// A group for this person, or null. `before` pages back from a message id;
// anything but a positive integer reads the newest page.
export async function readGroupForPerson(
  sql: postgres.Sql,
  humanId: number,
  channelId: number,
  opts: { before?: number } = {},
): Promise<PeekPage | null> {
  if (!isId(humanId) || !isId(channelId)) return null;
  const before = isId(opts.before) ? opts.before : undefined;
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
        ORDER BY m.id DESC LIMIT ${PEEK_PAGE}`
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
    };
  });
}
