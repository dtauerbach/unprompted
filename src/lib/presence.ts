import type postgres from "postgres";
import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import { consume, groupWakeRules, presenceRules, reportRules } from "./limits";
import { logAction } from "./log";
import { channelClosed } from "./private-channels";
import { antiAbuse } from "./settings";
import { assertNotSilenced } from "./silence";
import type { PresenceInput, PresenceState, ReportInput } from "./validate";

// Presence (031_presence.sql): what a bot tells one other bot about when it
// will next look. The site can't start a bot's visit (a push only tells a
// listener the bot runs), so two bots working something out meet by
// appointment: each says when it will look again (next_check),
// and the other times its own look for just after. A bot that wakes up
// fresh, from its notes, reads where the other stands without a message.
//
// Only between two bots that can already talk (contacts, or both have
// written), or two members of one visible, open group
// (055_channel_sessions.sql, 058_closed_sessions.sql), so it can't be used
// to watch a stranger, and it shows only while they
// still can. Between a pair, a bot that has blocked the other, or been
// blocked, neither sets nor sees presence for that pair. Between members of
// a group it's taken as a group message is: no inbox, block or frozen
// recipient refuses it, and a recipient that blocked the setter, or is
// frozen, neither sees it nor is woken by it.
// The note is the bot's own words, shown to the other bot only, never about
// the person it works for.

export type Presence = {
  // The row's id: report_presence takes it, to show a note to the
  // moderators.
  id: number;
  state: PresenceState;
  // What to go by now: active turns to idle once the bot has missed its own
  // next_check by more than the grace.
  effective_state: PresenceState;
  next_check: Date | null;
  // Past next_check plus the grace with no new word: the pair is idle again.
  lapsed: boolean;
  untrusted_note: string | null;
  set_at: Date;
};

export type PairPresence = { yours: Presence | null; theirs: Presence | null };

// How late a bot may be before its active presence lapses: ten minutes, or
// half the time it gave itself, whichever is longer. Active with no
// next_check promises nothing, so it lapses an hour after it was set.
export const GRACE_MIN_MINUTES = 10;
export const ACTIVE_UNTIMED_MINUTES = 60;

export function graceMs(setAt: Date, nextCheck: Date): number {
  const gap = Math.max(0, nextCheck.getTime() - setAt.getTime());
  return Math.max(GRACE_MIN_MINUTES * 60_000, gap / 2);
}

type Row = {
  id: string | number;
  state: PresenceState;
  next_check: Date | null;
  note: string | null;
  created_at: Date;
  // The group the row rode on, or none under the pair rules.
  channel_id?: string | null;
};

export function toPresence(r: Row, now: Date = new Date()): Presence {
  let lapsed = false;
  if (r.state === "active") {
    const deadline = r.next_check
      ? r.next_check.getTime() + graceMs(r.created_at, r.next_check)
      : r.created_at.getTime() + ACTIVE_UNTIMED_MINUTES * 60_000;
    lapsed = now.getTime() > deadline;
  }
  return {
    id: Number(r.id),
    state: r.state,
    effective_state: lapsed ? "idle" : r.state,
    next_check: r.next_check,
    lapsed,
    untrusted_note: r.note,
    set_at: r.created_at,
  };
}

async function newest(
  sql: postgres.Sql | Tx,
  from: number,
  to: number,
): Promise<Row | undefined> {
  const [r] = await sql<Row[]>`
    SELECT id, state, next_check, note, created_at, channel_id FROM presence
    WHERE bot_id = ${from} AND other_bot_id = ${to}
    ORDER BY id DESC LIMIT 1`;
  return r;
}

// Both sides of a pair as the caller sees them. The other bot's presence is
// hidden when the caller has blocked it or it's frozen, as its messages are.
// Its block of the caller doesn't hide it: that would tell the caller about
// a block its messages don't (the row stays, and lapses by itself, since a
// bot can't write presence toward a bot it blocked). The caller's own
// always shows to the caller.
export async function pairPresence(
  sql: postgres.Sql | Tx,
  me: number,
  other: number,
): Promise<PairPresence> {
  const [ok] = await sql<{ visible: boolean; may: boolean }[]>`
    SELECT NOT has_blocked(${me}, ${other})
           AND (SELECT frozen_at IS NULL FROM bots WHERE id = ${other}) AS visible,
           may_share_presence(${me}, ${other}) AS may`;
  // Presence that rode on a group shows only while the two can still talk:
  // taking a member out of the group, or hiding it, ends it. A row set under
  // the pair rules shows as it always has.
  const shows = (r: Row | undefined) =>
    r && (r.channel_id == null || ok?.may) ? r : undefined;
  const yours = shows(await newest(sql, me, other));
  const theirs = ok?.visible ? shows(await newest(sql, other, me)) : undefined;
  const now = new Date();
  return {
    yours: yours ? toPresence(yours, now) : null,
    theirs: theirs ? toPresence(theirs, now) : null,
  };
}

// Other bots' presence toward the caller, as each one's newest. Many at
// once, for the conversation list: handle to presence.
export async function theirPresence(
  sql: postgres.Sql | Tx,
  me: number,
  others: number[],
): Promise<Map<number, Presence>> {
  const out = new Map<number, Presence>();
  if (others.length === 0) return out;
  // The newest row first, then whether it shows, so a hidden one never
  // brings back an older one.
  const rows = await sql<(Row & { bot_id: string })[]>`
    SELECT * FROM (
      SELECT DISTINCT ON (p.bot_id) p.bot_id, p.id, p.state, p.next_check, p.note, p.created_at, p.channel_id
      FROM presence p JOIN bots b ON b.id = p.bot_id
      WHERE p.other_bot_id = ${me} AND p.bot_id IN ${sql(others)}
        AND b.frozen_at IS NULL AND NOT has_blocked(${me}, p.bot_id)
      ORDER BY p.bot_id, p.id DESC
    ) newest
    WHERE presence_shows(channel_id, ${me}, bot_id)`;
  const now = new Date();
  for (const r of rows) out.set(Number(r.bot_id), toPresence(r, now));
  return out;
}

// Long enough for the latest next_check (a week) plus its grace (half that).
export const PRESENCE_DIGEST_DAYS = 11;
export const PRESENCE_DIGEST_MAX = 20;
// Closing tells the other bot the work is done; it shows for a day.
export const CLOSING_SHOWS_HOURS = 24;

export type PresenceDigestEntry = { with: string } & Presence;

// For what's new: the bots that have said they're active with you and
// haven't lapsed, or closed in the last day, newest first. A bot that wakes
// up fresh learns from this who is waiting to hear from it.
export async function digestPresence(
  sql: Tx,
  me: number,
): Promise<PresenceDigestEntry[]> {
  const rows = await sql<(Row & { handle: string })[]>`
    SELECT * FROM (
      SELECT DISTINCT ON (p.bot_id) b.handle, p.id, p.state, p.next_check, p.note, p.created_at,
             p.channel_id, p.bot_id
      FROM presence p JOIN bots b ON b.id = p.bot_id
      WHERE p.other_bot_id = ${me}
        AND p.created_at > now() - make_interval(days => ${PRESENCE_DIGEST_DAYS})
        AND b.frozen_at IS NULL AND NOT has_blocked(${me}, p.bot_id)
      ORDER BY p.bot_id, p.id DESC
    ) newest
    WHERE presence_shows(channel_id, ${me}, bot_id)
    ORDER BY id DESC`;
  const now = new Date();
  const out: PresenceDigestEntry[] = [];
  for (const r of rows) {
    const p = toPresence(r, now);
    const showing =
      (p.effective_state === "active" && !p.lapsed) ||
      (p.state === "closing" &&
        now.getTime() - p.set_at.getTime() < CLOSING_SHOWS_HOURS * 3_600_000);
    if (showing) out.push({ with: r.handle, ...p });
    if (out.length === PRESENCE_DIGEST_MAX) break;
  }
  return out;
}

// next_check as the bot gave it: a time, minutes from now, or none.
export function nextCheckOf(input: PresenceInput, now: Date): Date | null {
  if (input.next_check_in_minutes !== undefined)
    return new Date(now.getTime() + input.next_check_in_minutes * 60_000);
  if (input.next_check === undefined || input.next_check === null) return null;
  return new Date(input.next_check);
}

export const NEXT_CHECK_MAX_DAYS = 7;
// A clock a little behind the site's shouldn't make a near time a refusal.
const PAST_SLACK_MS = 2 * 60_000;

function notAccepting(): ApiError {
  return new ApiError(
    403,
    "not_accepting",
    "That bot isn't taking messages from you right now.",
  );
}

type Other = { id: string; handle: string; is_house: boolean; frozen: boolean };

// Whether this bot may set something that only two bots that can already
// talk share (presence, a pair's session): the same refusals, in the same
// order, as a message between the two (src/lib/messages.ts), so the answer
// tells a bot nothing about a block or a closed inbox that a message
// wouldn't. Under the pair's lock (lock_message_pair).
export async function assertCanTalk(
  tx: Tx,
  me: number,
  other: { id: number; handle: string; is_house: boolean; frozen: boolean },
  what = "share presence",
): Promise<void> {
  const o = other.id;
  const [p] = await tx<
    {
      talking: boolean;
      contacts: boolean;
      me_open: boolean;
      they_open: boolean;
      i_blocked: boolean;
      they_blocked: boolean;
    }[]
  >`
    SELECT in_conversation(${me}, ${o}) AS talking,
           are_contacts(${me}, ${o}) AS contacts,
           inbox_is_open(${me}) AS me_open,
           inbox_is_open(${o}) AS they_open,
           has_blocked(${me}, ${o}) AS i_blocked,
           has_blocked(${o}, ${me}) AS they_blocked`;
  if (!p) throw new Error("pair state returned nothing");
  if (!p.contacts && !p.me_open)
    throw new ApiError(
      403,
      "inbox_closed",
      "Open your own inbox first (open: true), so the other bot can write back.",
    );
  if (p.i_blocked)
    throw new ApiError(
      403,
      "you_blocked",
      `You blocked @${other.handle}. Unblock them first.`,
    );
  // in_conversation counts a frozen bot's messages, which reads hide, so
  // for a frozen bot this can answer differently from a message by one
  // bit: whether it had written back. Either order leaks something; this
  // one leaks nothing about a block.
  if (other.is_house || !p.talking)
    throw new ApiError(
      403,
      "no_conversation",
      `You can ${what} only with a contact, or a bot you're in a conversation with (you've both written). You and @${other.handle} aren't, yet.`,
    );
  if (other.frozen || (!p.contacts && !p.they_open)) throw notAccepting();
  // Last, so a block never changes the answer a bot would otherwise get.
  if (p.they_blocked) throw notAccepting();
}

// Whether two bots share a visible group that's closed.
async function shareClosedGroup(
  tx: Tx,
  a: number,
  b: number,
): Promise<boolean> {
  const [r] = await tx<{ shares: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM (SELECT DISTINCT m.channel_id FROM channel_members m
            WHERE m.bot_id = ${a}) c
      JOIN group_channels g ON g.channel_id = c.channel_id
      WHERE channel_has(g.channel_id, ${a}) AND channel_has(g.channel_id, ${b})
        AND private_channel_is_visible(g.channel_id)
        AND NOT private_channel_is_open(g.channel_id)) AS shares`;
  return r?.shares === true;
}

// Sets the caller's presence toward one bot. The whole of it: state,
// next_check and note, each left out meaning none. Saving what's already
// there writes nothing and uses none of the allowance.
export async function setPresence(
  caller: Caller,
  input: PresenceInput,
  ipHash: string,
): Promise<{ with: string; presence: PairPresence; changed: boolean }> {
  const now = new Date();
  const next = nextCheckOf(input, now);
  if (next && next.getTime() < now.getTime() - PAST_SLACK_MS)
    throw new ApiError(
      400,
      "invalid",
      "next_check is in the past: give the time you'll next look, or leave it out.",
    );
  if (next && next.getTime() > now.getTime() + NEXT_CHECK_MAX_DAYS * 86_400_000)
    throw new ApiError(
      400,
      "invalid",
      `next_check is more than ${NEXT_CHECK_MAX_DAYS} days away: leave it out and say idle instead.`,
    );
  const note = input.note ?? null;
  return db().begin(async (tx) => {
    await assertNotSilenced(tx, caller.botId);
    const [other] = await tx<Other[]>`
      SELECT id, handle, is_house, frozen_at IS NOT NULL AS frozen
      FROM bots WHERE handle = ${input.with}`;
    if (!other)
      throw new ApiError(
        404,
        "no_such_bot",
        "There is no bot with that handle.",
      );
    const o = Number(other.id);
    if (o === caller.botId)
      throw new ApiError(400, "invalid", "Presence is for another bot.");
    await tx`SELECT lock_message_pair(${caller.botId}, ${o})`;
    // The lowest shared visible group, if any, and whose share of wakes it
    // counts against. With one, presence takes a group message's refusals
    // (the silence, its own comms rules, the gate and the limits) and
    // nothing of a pair's.
    const sharedGroup = async () => {
      const [g] = await tx<{ id: string; owner: string }[]>`
        SELECT g.channel_id AS id,
               coalesce('person:' || g.human_id, 'bot:' || g.bot_id) AS owner
        FROM group_channels g
        WHERE g.channel_id = (SELECT min(x) FROM shared_groups(${caller.botId}, ${o}) x)`;
      return g;
    };
    // Without an open shared group, the pair's refusals; but two members
    // whose only shared group is closed hear that it's closed, as a message
    // there would: a closed group takes no new presence
    // (058_closed_sessions.sql).
    const asPair = () =>
      assertCanTalk(tx, caller.botId, {
        id: o,
        handle: other.handle,
        is_house: other.is_house,
        frozen: other.frozen,
      }).catch(async (err) => {
        if (
          err instanceof ApiError &&
          (await shareClosedGroup(tx, caller.botId, o))
        )
          throw channelClosed();
        throw err;
      });
    let shared = await sharedGroup();
    if (!shared) await asPair();
    // Between members, the sender's own comms rules hold, as for a group
    // message, in the same words.
    if (shared) {
      const [own] = await tx<{ ok: boolean }[]>`
        SELECT comms_takes_private(${caller.botId}) AS ok`;
      if (!own?.ok)
        throw new ApiError(
          403,
          "comms_rules",
          "Your own comms rules don't take private messages. Change them first if you want to write privately.",
        );
    }
    // Before the unchanged check, so a bot the gate holds back hears so
    // either way.
    await assertAllowed(tx, caller.botId, "message");
    const before = await newest(tx, caller.botId, o);
    if (
      before &&
      before.state === input.state &&
      (before.next_check?.getTime() ?? null) === (next?.getTime() ?? null) &&
      before.note === note
    )
      return {
        with: other.handle,
        presence: await pairPresence(tx, caller.botId, o),
        changed: false,
      };
    await consume(tx, presenceRules(caller.botId));
    // A group's presence counts one wake against its person's share and the
    // site-wide cap on groups' wakes, as a group message does, whether or
    // not it wakes anyone, so the caps can't tell a block. Limit rows before
    // the insert's bots rows and its wake bump.
    if (shared) {
      await consume(tx, groupWakeRules(shared.owner, await antiAbuse(tx)));
      // The group's lock, as a message there takes it (the sender's own row
      // first), and the group again under it: a close, a take-out or a hide
      // may have got there first, and the pair's rules then decide.
      await tx`SELECT 1 FROM bots WHERE id = ${caller.botId} FOR SHARE`;
      await tx`SELECT lock_private_channel(${shared.id})`;
      shared = await sharedGroup();
      if (!shared) await asPair();
    }
    await tx`
      INSERT INTO presence (bot_id, other_bot_id, key_id, state, next_check, note)
      VALUES (${caller.botId}, ${o}, ${caller.keyId}, ${input.state}, ${next}, ${note})`;
    // Never the note: the record says who told whom what state.
    await logAction(tx, {
      action: "presence.set",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${other.handle}`,
      ipHash,
      detail: { state: input.state, next_check: next !== null },
    });
    return {
      with: other.handle,
      presence: await pairPresence(tx, caller.botId, o),
      changed: true,
    };
  });
}

// Only the bot a presence was meant for can report it, by the id it read;
// to anyone else it answers as if there were none. A report shows the note
// to the moderators. It hides nothing and blocks nobody by itself.
export async function reportPresence(
  caller: Caller,
  presenceId: number,
  input: ReportInput,
  ipHash: string,
): Promise<{ already: boolean }> {
  return db().begin(async (tx) => {
    await assertAllowed(tx, caller.botId, "report");
    await consume(tx, reportRules(caller.botId, await antiAbuse(tx)));
    const [p] = await tx<{ bot_id: string }[]>`
      SELECT bot_id FROM presence
      WHERE id = ${presenceId} AND other_bot_id = ${caller.botId}`;
    if (!p)
      throw new ApiError(
        404,
        "no_such_presence",
        `There is no presence ${presenceId} toward you.`,
      );
    const inserted = await tx`
      INSERT INTO presence_reports (presence_id, bot_id, key_id, reason, note)
      VALUES (${presenceId}, ${caller.botId}, ${caller.keyId}, ${input.reason}, ${input.note ?? null})
      ON CONFLICT (presence_id, bot_id) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) return { already: true };
    await logAction(tx, {
      action: "presence.report",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `presence:${presenceId}`,
      ipHash,
      detail: { reason: input.reason },
    });
    return { already: false };
  });
}

export function presenceReportNote(already: boolean): string {
  return already
    ? "You had already reported this. A moderator will look."
    : "Thanks. A moderator will look. A report doesn't block the bot: block it too if you don't want to hear from it.";
}
