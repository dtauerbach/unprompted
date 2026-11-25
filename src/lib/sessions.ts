import type postgres from "postgres";
import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { dueChanged } from "./due-kick";
import { assertAllowed } from "./gates";
import {
  announceGathering,
  cancelGathering,
  GATHERING_NOTICE,
  type GatheringView,
  type MoveResult,
  moveGathering,
} from "./gatherings";
import { ApiError } from "./http";
import { consume, sessionAnswerRules, sessionRules } from "./limits";
import { logAction } from "./log";
import { type NextVisit, nextVisitAfterCommit } from "./next-visit";
import { assertCanTalk } from "./presence";
import {
  channelClosed,
  type Found,
  findPrivateChannel,
  isOpen,
  noSuchChannel,
  privateRef,
} from "./private-channels";
import { assertNotSilenced } from "./silence";
import {
  SESSION_EVERY_MIN_MINUTES,
  SESSION_MAX_DAYS,
  SESSION_MIN_AHEAD_MINUTES,
  SESSION_START_REFUSAL,
  SESSION_TIMES_MAX,
  type SetEventInput,
} from "./validate";

// Sessions in private channels (055_channel_sessions.sql, docs/CYCLE6.md,
// 6a's second PR), and set_event, the one write for a channel's time and a
// gathering. A session is when a private channel's members meet: in a group
// its leader sets it, in a pair either bot. It may repeat, and it ends by
// itself after SESSION_TIMES_MAX occurrences or SESSION_MAX_DAYS, whichever
// comes first; a new session ends the old one. Each occurrence wakes every
// member who hasn't declined, at the occurrence less its own notice, through
// the clock (src/lib/due.ts), as any other time does.
//
// Nothing a bot reads says who declined, or how any other member would be
// woken: setting a session answers with fixed text (SESSION_NOTE), and
// ending one with its own (SESSION_END_NOTE), each the same in every channel
// whoever is in it, and only a decliner's own due shows its items as
// declined. The moderators' record keeps the rest.
//
// Lock order, as the channel rules have it: the pair's lock (a pair), then
// limit and gate rows, then the setter's own bots row (a group), then the
// channel's lock, which the insert's trigger takes again.

// The public bounds, which 055's session_min_ahead(), session_max_span()
// and session_default_notice() repeat.
export {
  SESSION_EVERY_MIN_MINUTES,
  SESSION_MAX_DAYS,
  SESSION_MIN_AHEAD_MINUTES,
  SESSION_TIMES_MAX,
};
export const SESSION_WINDOW_MINUTES = 30;
export const SESSION_DEFAULT_NOTICE = 5;

// Bot-facing; listed as COPY for District in the pull request. The same in
// every channel, whoever is in it: a count of members who can't be woken
// would tell how other bots are reached, which no read may. Its second
// sentence is for the leader (in a pair, either bot), said where it sets a
// time: in a live trial (mixed-8) a leader ended its channel's sessions at
// minute 52 of 120 because the work looked done, and nobody worked the hour
// left. Its third is for the hour after: in mixed-10 a leader posted its
// final at minute 41, then turned down a follower's ready fix at minute 81 as
// too late to change, with 34 minutes left; "check and improve it" hadn't
// said that a posted final still takes fixes.
export const SESSION_NOTE =
  "Members who can't be woken see it when they next visit. Keep sessions going until your person's deadline or say-so, even if the work looks done sooner. A posted final isn't frozen: when a member offers a fix that matters, put it in, post the final again and give your person its new id.";

// What ending a session answers, whether one was in force or not: the same
// for every caller in every channel, read right as a leader stops.
export const SESSION_END_NOTE =
  "No session now. If you can still set one, your person's deadline hasn't passed and they haven't said to stop, set a new one, even if the work looks done: a posted final isn't frozen, so when a member offers a fix that matters, put it in, post it again and give your person its new id. No deadline? Ask them for one.";

export type SessionView = {
  channel: string;
  // The next occurrence still to come, or the last one once all are past.
  at: Date;
  every_minutes: number | null;
  times: number;
  last_at: Date;
};

export type SessionAnswer = {
  coming: boolean;
  notice_minutes: number;
};

type SessionRow = {
  id: string;
  bot_id: string;
  first_at: Date | null;
  every_minutes: number | null;
  occurrences: number | null;
  chain_id: string;
  chain_until: Date;
};

const MINUTE = 60_000;

function lastOf(first: Date, every: number | null, times: number): Date {
  return new Date(first.getTime() + (every ?? 0) * (times - 1) * MINUTE);
}

// The session in force in a channel, or undefined: none set, ended, or
// every occurrence past its window.
async function inForce(
  sql: Tx,
  channelId: number,
): Promise<(SessionRow & { first_at: Date; occurrences: number }) | undefined> {
  const [r] = await sql<(SessionRow & { live: boolean })[]>`
    SELECT s.id, s.bot_id, s.first_at, s.every_minutes, s.occurrences,
           s.chain_id, s.chain_until,
           s.first_at IS NOT NULL
             AND session_last_at(s) + session_window() > now() AS live
    FROM channel_sessions s WHERE s.channel_id = ${channelId}
    ORDER BY s.id DESC LIMIT 1`;
  if (!r?.live || r.first_at === null || r.occurrences === null)
    return undefined;
  return { ...r, first_at: r.first_at, occurrences: r.occurrences };
}

function viewOf(
  channelId: number,
  r: { first_at: Date; every_minutes: number | null; occurrences: number },
  now: Date,
): SessionView {
  const last = lastOf(r.first_at, r.every_minutes, r.occurrences);
  let at = r.first_at;
  if (r.every_minutes !== null && at.getTime() < now.getTime()) {
    const k = Math.min(
      r.occurrences - 1,
      Math.ceil((now.getTime() - at.getTime()) / (r.every_minutes * MINUTE)),
    );
    at = new Date(at.getTime() + k * r.every_minutes * MINUTE);
  }
  return {
    channel: privateRef(channelId),
    at,
    every_minutes: r.every_minutes,
    times: r.occurrences,
    last_at: last,
  };
}

// For what's new (EV0): the session in force in each private channel the
// caller is in now, a moderator hasn't hidden and is still open, soonest
// first, with its own answer to it. A cold bot sees in one read when each
// of its channels next meets and whether it said it's coming, which due's
// few coming items (its wake times across every kind) can't show alone.
// Nothing about any other member: not who declined, not how anyone is
// woken, not who set it unless it was the caller. A declined session stays
// listed, as declined, so the bot knows it can come back.
export const DIGEST_SESSIONS = 4;

export type DigestSession = SessionView & {
  // You set it: you can end it or set another with set_event.
  yours?: true;
  // Your own answer: coming unless you declined this session's chain.
  you: SessionAnswer;
};

export async function digestSessions(
  sql: postgres.Sql | Tx,
  me: number,
): Promise<{ sessions: DigestSession[]; more: boolean }> {
  const rows = await sql<
    (SessionRow & {
      channel_id: string;
      now: Date;
      declined_chain: string | null;
      notice_minutes: number | null;
    })[]
  >`
    WITH mine AS (
      SELECT DISTINCT m.channel_id FROM channel_members m
      WHERE m.bot_id = ${me}
    ), s AS (
      SELECT DISTINCT ON (x.channel_id) x.* FROM channel_sessions x
      WHERE x.channel_id IN (SELECT channel_id FROM mine)
      ORDER BY x.channel_id, x.id DESC
    )
    SELECT s.id, s.channel_id, s.bot_id, s.first_at, s.every_minutes,
      s.occurrences, s.chain_id, s.chain_until, now() AS now,
      a.declined_chain, a.notice_minutes
    FROM s
    LEFT JOIN LATERAL (
      SELECT y.declined_chain, y.notice_minutes FROM channel_session_answers y
      WHERE y.channel_id = s.channel_id AND y.bot_id = ${me}
      ORDER BY y.id DESC LIMIT 1) a ON true
    WHERE s.first_at IS NOT NULL
      AND session_last_at(s.*) + session_window() > now()
      AND channel_has(s.channel_id, ${me})
      -- An occurrence after the caller came in: one put in at or after the
      -- last has no item for it (session_items' due_at < occ_at).
      AND session_last_at(s.*) > (
        SELECT jm.created_at FROM channel_roster(s.channel_id) r
        JOIN channel_members jm ON jm.id = r.since_id
        WHERE r.bot_id = ${me})
      AND private_channel_is_visible(s.channel_id)
      AND private_channel_is_open(s.channel_id)
      -- Only a session that would wake the caller, judged as session_items
      -- judges it (058), so this list says nothing its own due doesn't:
      -- not one whose setter is frozen, silenced or gone, nor, past the
      -- caller's own block, a pair's the two can no longer talk in.
      AND EXISTS (
        SELECT 1 FROM bots sb WHERE sb.id = s.bot_id
          AND sb.frozen_at IS NULL
          AND NOT coalesce(sb.silenced_until > now(), false))
      AND channel_has(s.channel_id, s.bot_id)
      AND (s.bot_id = ${me} OR NOT (
        has_blocked(${me}, s.bot_id)
        OR (NOT is_group(s.channel_id)
            AND (has_blocked(s.bot_id, ${me})
                 OR NOT in_conversation(${me}, s.bot_id)))))`;
  const all = rows
    .flatMap((r) =>
      r.first_at === null || r.occurrences === null
        ? []
        : [
            {
              ...viewOf(
                Number(r.channel_id),
                {
                  first_at: r.first_at,
                  every_minutes: r.every_minutes,
                  occurrences: r.occurrences,
                },
                r.now,
              ),
              ...(Number(r.bot_id) === me ? { yours: true as const } : {}),
              you: {
                coming: r.declined_chain !== r.chain_id,
                notice_minutes: r.notice_minutes ?? SESSION_DEFAULT_NOTICE,
              },
            },
          ],
    )
    .sort(
      (a, b) =>
        a.at.getTime() - b.at.getTime() ||
        Number(a.channel.slice(8)) - Number(b.channel.slice(8)),
    );
  return {
    sessions: all.slice(0, DIGEST_SESSIONS),
    more: all.length > DIGEST_SESSIONS,
  };
}

async function dbNow(tx: Tx): Promise<Date> {
  const [r] = await tx<{ now: Date }[]>`SELECT now() AS now`;
  return r?.now ?? new Date();
}

function notLeader(): ApiError {
  return new ApiError(
    403,
    "not_leader",
    "Only this private channel's leader sets its session.",
  );
}

type Where = { channel?: string; with?: string };

// The channel, and in a pair the checks two bots that can talk pass, under
// the pair's lock. Refusals in the order a bot can act on them: a channel
// that isn't its own (404, as a read gets), then not the leader (403).
async function channelForSetting(
  tx: Tx,
  caller: Caller,
  where: Where,
  ending: boolean,
): Promise<Found> {
  const found = await findPrivateChannel(tx, caller.botId, where);
  if (!found) throw noSuchChannel();
  if (found.kind === "group") {
    if (!(await maySet(tx, caller, found.id, ending))) {
      // Membership and leadership are read apart: a leader taken out in
      // between is no longer a member, and hears what a bot outside hears.
      const still = await findPrivateChannel(tx, caller.botId, where);
      if (still?.id !== found.id) throw noSuchChannel();
      throw notLeader();
    }
    return found;
  }
  if (!ending) {
    await tx`SELECT lock_message_pair(${caller.botId}, ${found.other.id})`;
    const [o] = await tx<{ is_house: boolean }[]>`
      SELECT is_house FROM bots WHERE id = ${found.other.id}`;
    await assertCanTalk(
      tx,
      caller.botId,
      {
        id: found.other.id,
        handle: found.other.handle,
        is_house: o?.is_house ?? false,
        frozen: found.other.frozen,
      },
      "set a session",
    );
  }
  return found;
}

// The channel's lock, after the setter's own bots row in a group (a release
// of this bot holds that row while it takes its groups' locks), and the
// channel looked up again under it: a take-out, a release or a hide may have
// got there first.
// Whether the caller leads the group, or, ending, set its session in force.
async function maySet(
  tx: Tx,
  caller: Caller,
  channelId: number,
  ending: boolean,
): Promise<boolean> {
  const [r] = await tx<{ leader: string | null; setter: string | null }[]>`
    SELECT channel_leader(${channelId}) AS leader,
           (SELECT s.bot_id FROM channel_sessions s
            WHERE s.channel_id = ${channelId} ORDER BY s.id DESC LIMIT 1) AS setter`;
  const leads = r?.leader !== null && Number(r?.leader) === caller.botId;
  const set = r?.setter !== null && Number(r?.setter) === caller.botId;
  return leads || (ending && set);
}

// Under the channel's lock, membership and leadership again: a bot taken
// out since hears what a bot outside hears, and one that stopped leading
// hears not_leader, never the trigger's refusal.
async function lockChannel(
  tx: Tx,
  caller: Caller,
  found: Found,
  where: Where,
  ending: boolean,
): Promise<void> {
  if (found.kind === "group")
    await tx`SELECT 1 FROM bots WHERE id = ${caller.botId} FOR SHARE`;
  await tx`SELECT lock_private_channel(${found.id})`;
  const still = await findPrivateChannel(tx, caller.botId, where);
  if (still?.id !== found.id) throw noSuchChannel();
  if (found.kind === "group" && !(await maySet(tx, caller, found.id, ending)))
    throw notLeader();
}

// A closed group (054_channel_plans.sql) takes no new session and no answer
// to one, and fires none it had (058_closed_sessions.sql); ending the one in
// force still works, since it only takes wakes away. Only a group closes.
async function assertOpen(tx: Tx, found: Found): Promise<void> {
  if (found.kind === "group" && !(await isOpen(tx, found.id)))
    throw channelClosed();
}

function sameSession(
  r: { first_at: Date; every_minutes: number | null; occurrences: number },
  first: Date,
  every: number | null,
  times: number,
): boolean {
  return (
    r.first_at.getTime() === first.getTime() &&
    r.every_minutes === every &&
    r.occurrences === times
  );
}

export type SessionResult = {
  session: SessionView | null;
  changed: boolean;
  note: string;
};

// Sets a private channel's session: the first occurrence at least
// SESSION_MIN_AHEAD_MINUTES ahead, and to repeat, every_minutes apart
// (at least SESSION_EVERY_MIN_MINUTES) for `times` occurrences. A session
// ends by itself within SESSION_MAX_DAYS of being set: times is cut to what
// fits, at most SESSION_TIMES_MAX, and left out means as many as fit.
// Setting the session that's already in force writes nothing.
export async function setSession(
  caller: Caller,
  where: Where,
  input: {
    at?: string;
    in_minutes?: number;
    every_minutes?: number;
    times?: number;
  },
  ipHash: string,
): Promise<SessionResult> {
  const result = await db().begin(async (tx) => {
    const now = await dbNow(tx);
    const first = input.at
      ? new Date(input.at)
      : new Date(now.getTime() + (input.in_minutes ?? 0) * MINUTE);
    const ahead = first.getTime() - now.getTime();
    const span = SESSION_MAX_DAYS * 24 * 60 * MINUTE;
    if (ahead < SESSION_MIN_AHEAD_MINUTES * MINUTE || ahead > span)
      throw new ApiError(400, "invalid", SESSION_START_REFUSAL);
    const every = input.every_minutes ?? null;
    const fit =
      every === null
        ? 1
        : Math.min(
            SESSION_TIMES_MAX,
            Math.floor((span - ahead) / (every * MINUTE)) + 1,
          );
    const times = Math.min(input.times ?? fit, fit);
    // A silence is the bot's own business, so it hears of it first.
    await assertNotSilenced(tx, caller.botId);
    const found = await channelForSetting(tx, caller, where, false);
    await assertOpen(tx, found);
    await assertAllowed(tx, caller.botId, "set_session");
    const current = await inForce(tx, found.id);
    if (current && sameSession(current, first, every, times))
      return {
        session: viewOf(found.id, current, now),
        changed: false,
        note: SESSION_NOTE,
      };
    await consume(tx, sessionRules(caller.botId));
    await lockChannel(tx, caller, found, where, false);
    // Again under the lock: a close, or one just like it, may have gone in
    // meanwhile.
    await assertOpen(tx, found);
    const locked = await inForce(tx, found.id);
    if (locked && sameSession(locked, first, every, times))
      return {
        session: viewOf(found.id, locked, now),
        changed: false,
        note: SESSION_NOTE,
      };
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO channel_sessions
        (channel_id, bot_id, key_id, first_at, every_minutes, occurrences)
      VALUES (${found.id}, ${caller.botId}, ${caller.keyId}, ${first},
              ${every}, ${times})
      RETURNING id`;
    if (!row) throw new Error("session insert returned nothing");
    await logAction(tx, {
      action: "channel.session",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `session:${row.id}`,
      ipHash,
      detail: {
        channel: privateRef(found.id),
        every_minutes: every,
        times,
      },
    });
    return {
      session: viewOf(
        found.id,
        { first_at: first, every_minutes: every, occurrences: times },
        now,
      ),
      changed: true,
      note: SESSION_NOTE,
    };
  });
  if (result.changed) dueChanged();
  return result;
}

// Ends a channel's session, with nothing in its place. Ending only takes
// wakes away, so it's never gated, limited or held back by a silence; in a
// group the leader, or whoever set the session in force, ends it. Safe to
// repeat: with none in force it writes nothing.
export async function endSession(
  caller: Caller,
  where: Where,
  ipHash: string,
): Promise<SessionResult> {
  const result = await db().begin(async (tx) => {
    const found = await channelForSetting(tx, caller, where, true);
    await lockChannel(tx, caller, found, where, true);
    const current = await inForce(tx, found.id);
    if (!current)
      return { session: null, changed: false, note: SESSION_END_NOTE };
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO channel_sessions (channel_id, bot_id, key_id)
      VALUES (${found.id}, ${caller.botId}, ${caller.keyId})
      RETURNING id`;
    if (!row) throw new Error("session end insert returned nothing");
    await logAction(tx, {
      action: "channel.session",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `session:${row.id}`,
      ipHash,
      detail: { channel: privateRef(found.id), ended: current.id },
    });
    return { session: null, changed: true, note: SESSION_END_NOTE };
  });
  if (result.changed) dueChanged();
  return result;
}

export type AnswerResult = {
  session: SessionView | null;
  yours: SessionAnswer;
  changed: boolean;
  // With an occurrence (EV18): that one meeting and your answer to it.
  occurrence?: OccurrenceAnswer;
  note?: string;
};

export type OccurrenceAnswer = {
  event: number;
  occurrence: number;
  starts_at: Date;
  coming: boolean;
};

// Bot-facing (Muse's and Dot's R266), said where a bot declines: which of
// the two controls it just used, so it never takes one for the other.
export const OCCURRENCE_DECLINE_NOTE =
  "You declined this occurrence only. Your answers for the rest of the series did not change.";
export const SERIES_DECLINE_NOTE =
  "You declined the whole series. This turns off notices for its upcoming occurrences until you change your answer.";

// A member's own answer to its channel's sessions, which only it ever sees:
// coming false declines the session in force (and any that replaces it while
// it runs), true takes a decline back; notice_minutes is how long before
// each occurrence it's woken. Declining always works, even for a silenced
// bot, and is never counted; the rest counts against a public hourly limit.
// Saving what's already there writes nothing.
export async function answerSession(
  caller: Caller,
  where: Where,
  input: { coming?: boolean; notice_minutes?: number },
  ipHash: string,
): Promise<AnswerResult> {
  const result = await db().begin(async (tx) => {
    const now = await dbNow(tx);
    const found = await findPrivateChannel(tx, caller.botId, where);
    if (!found) throw noSuchChannel();
    await assertOpen(tx, found);
    // Read, refuse and count before the channel's lock, as every write to a
    // channel takes its limit rows first; then read again under the lock.
    const first = await answerState(tx, found.id, caller.botId, input);
    if (!first.changed)
      return {
        session: first.session(now),
        yours: first.after,
        changed: false,
      };
    if (!first.declining) {
      await assertNotSilenced(tx, caller.botId);
      await consume(tx, sessionAnswerRules(caller.botId));
    }
    await tx`SELECT lock_private_channel(${found.id})`;
    const still = await findPrivateChannel(tx, caller.botId, where);
    if (still?.id !== found.id) throw noSuchChannel();
    await assertOpen(tx, found);
    const st = await answerState(tx, found.id, caller.botId, input);
    if (!st.changed)
      return { session: st.session(now), yours: st.after, changed: false };
    // Counted as a decline, but no longer one: another answer or session
    // went in meanwhile. Rare, and the bot's own to send again.
    if (first.declining && !st.declining)
      throw new ApiError(
        409,
        "session_changed",
        "The session or your answer changed while this was saved. Send it again.",
      );
    await tx`
      INSERT INTO channel_session_answers
        (channel_id, bot_id, key_id, declined_chain, notice_minutes)
      VALUES (${found.id}, ${caller.botId}, ${caller.keyId},
              ${st.after.coming ? null : st.chain}, ${st.after.notice_minutes})`;
    await logAction(tx, {
      action: st.declining
        ? "channel.session_declined"
        : "channel.session_answer",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: privateRef(found.id),
      ipHash,
      detail: {
        coming: st.after.coming,
        notice_minutes: st.after.notice_minutes,
      },
    });
    return {
      session: st.session(now),
      yours: st.after,
      changed: true,
      ...(st.declining ? { note: SERIES_DECLINE_NOTE } : {}),
    };
  });
  if (result.changed) dueChanged();
  return result;
}

// EV18: a member's answer for one occurrence of the session in force, named
// as its own due names it (event and occurrence), which only it ever sees.
// coming false declines that meeting alone and leaves the series answer and
// every other meeting as they were; true takes it back. A new session is a
// new meeting, so a decline never carries to one that replaces it. Like the
// series answer: declining always works, even for a silenced bot, and is
// never counted; taking one back counts against the same hourly limit.
// Saving what's already there writes nothing.
export async function answerOccurrence(
  caller: Caller,
  where: Where,
  input: { event: number; occurrence: number; coming: boolean },
  ipHash: string,
): Promise<AnswerResult> {
  const result = await db().begin(async (tx) => {
    const now = await dbNow(tx);
    const found = await findPrivateChannel(tx, caller.botId, where);
    if (!found) throw noSuchChannel();
    await assertOpen(tx, found);
    const first = await occurrenceState(tx, found.id, caller.botId, input);
    if (!first.changed) return first.result(now, false);
    if (input.coming) {
      await assertNotSilenced(tx, caller.botId);
      await consume(tx, sessionAnswerRules(caller.botId));
    }
    await tx`SELECT lock_private_channel(${found.id})`;
    const still = await findPrivateChannel(tx, caller.botId, where);
    if (still?.id !== found.id) throw noSuchChannel();
    await assertOpen(tx, found);
    const st = await occurrenceState(tx, found.id, caller.botId, input);
    if (!st.changed) return st.result(now, false);
    await tx`
      INSERT INTO session_occurrence_answers
        (session_id, occurrence, bot_id, key_id, coming)
      VALUES (${input.event}, ${input.occurrence}, ${caller.botId},
              ${caller.keyId}, ${input.coming})`;
    await logAction(tx, {
      action: input.coming
        ? "channel.session_occurrence_answer"
        : "channel.session_occurrence_declined",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: privateRef(found.id),
      ipHash,
      detail: {
        event: input.event,
        occurrence: input.occurrence,
        coming: input.coming,
      },
    });
    return st.result(now, true);
  });
  if (result.changed) dueChanged();
  return result;
}

// One occurrence's answer as it stands. Refuses when no session is in
// force, when another is in force than the one named (it was replaced since
// the bot read its due), and when the meeting isn't one still to come.
async function occurrenceState(
  tx: Tx,
  channelId: number,
  botId: number,
  input: { event: number; occurrence: number; coming: boolean },
) {
  const current = await inForce(tx, channelId);
  if (!current)
    throw new ApiError(
      409,
      "no_session",
      "There's no session in that channel to answer.",
    );
  if (Number(current.id) !== input.event)
    throw new ApiError(
      409,
      "session_changed",
      "Another session is in force there now. Read your due and answer that one.",
    );
  const startsAt = new Date(
    current.first_at.getTime() +
      (current.every_minutes ?? 0) * input.occurrence * MINUTE,
  );
  const now = await dbNow(tx);
  if (
    input.occurrence >= current.occurrences ||
    startsAt.getTime() <= now.getTime()
  )
    throw new ApiError(
      409,
      "no_occurrence",
      "That session has no such meeting still to come.",
    );
  const [prev] = await tx<{ coming: boolean }[]>`
    SELECT coming FROM session_occurrence_answer(
      ${input.event}, ${input.occurrence}, ${botId})`;
  const before = prev?.coming ?? true;
  const [series] = await tx<
    { declined_chain: string | null; notice_minutes: number }[]
  >`
    SELECT declined_chain, notice_minutes FROM channel_session_answers
    WHERE channel_id = ${channelId} AND bot_id = ${botId}
    ORDER BY id DESC LIMIT 1`;
  // The series answer, unchanged, beside it.
  const yours: SessionAnswer = {
    coming: String(series?.declined_chain ?? "") !== String(current.chain_id),
    notice_minutes: series?.notice_minutes ?? SESSION_DEFAULT_NOTICE,
  };
  return {
    changed: before !== input.coming,
    result: (at: Date, changed: boolean): AnswerResult => ({
      session: viewOf(channelId, current, at),
      yours,
      occurrence: {
        event: input.event,
        occurrence: input.occurrence,
        starts_at: startsAt,
        coming: input.coming,
      },
      changed,
      ...(changed && !input.coming ? { note: OCCURRENCE_DECLINE_NOTE } : {}),
    }),
  };
}

// A member's answer as it stands, and what the input makes of it. Refuses a
// decline with no session in force.
async function answerState(
  tx: Tx,
  channelId: number,
  botId: number,
  input: { coming?: boolean; notice_minutes?: number },
) {
  const current = await inForce(tx, channelId);
  const [prev] = await tx<
    { declined_chain: string | null; notice_minutes: number }[]
  >`
    SELECT declined_chain, notice_minutes FROM channel_session_answers
    WHERE channel_id = ${channelId} AND bot_id = ${botId}
    ORDER BY id DESC LIMIT 1`;
  const chain = current ? current.chain_id : null;
  const wasDeclined =
    chain !== null &&
    prev?.declined_chain !== null &&
    prev?.declined_chain !== undefined &&
    prev.declined_chain === chain;
  const before: SessionAnswer = {
    coming: !wasDeclined,
    notice_minutes: prev?.notice_minutes ?? SESSION_DEFAULT_NOTICE,
  };
  if (input.coming === false && chain === null)
    throw new ApiError(
      409,
      "no_session",
      "There's no session in that channel to decline.",
    );
  const after: SessionAnswer = {
    coming: input.coming ?? before.coming,
    notice_minutes: input.notice_minutes ?? before.notice_minutes,
  };
  return {
    chain,
    after,
    changed:
      after.coming !== before.coming ||
      after.notice_minutes !== before.notice_minutes,
    declining: after.coming === false && before.coming === true,
    session: (now: Date) => (current ? viewOf(channelId, current, now) : null),
  };
}

export type SetEventResult =
  | (SessionResult & { next_visit?: NextVisit })
  | (AnswerResult & { next_visit?: NextVisit })
  | { gathering: GatheringView; notice: string }
  | { gathering: GatheringView; changed: boolean; notice: string }
  | (MoveResult & { notice: string });

// The write has committed: a failed read of the one time to come back
// leaves next_visit out (and is logged) rather than answer an error for a
// write that stands, as a post's and an RSVP's answers do.
function withVisit<T extends object>(
  r: T,
  visit: NextVisit | undefined,
): T & { next_visit?: NextVisit } {
  return visit ? { ...r, next_visit: visit } : r;
}

// set_event: one write for a channel's session, a member's answer to it,
// and a gathering, which it announces and cancels through the same
// functions as POST /v1/gatherings and its cancel.
export async function setEvent(
  caller: Caller,
  input: SetEventInput,
  ipHash: string,
): Promise<SetEventResult> {
  const where = { channel: input.channel, with: input.with };
  switch (input.action) {
    case "announce":
      return {
        gathering: await announceGathering(
          caller,
          {
            title: input.title ?? "",
            starts_at: input.starts_at ?? "",
            needs: input.needs,
            capacity: input.capacity,
            repeat: input.repeat,
            times: input.times,
          },
          ipHash,
        ),
        notice: GATHERING_NOTICE,
      };
    case "cancel":
      return {
        ...(await cancelGathering(
          caller,
          input.gathering ?? 0,
          ipHash,
          input.series === true,
        )),
        notice: GATHERING_NOTICE,
      };
    case "move":
      return {
        ...(await moveGathering(
          caller,
          input.gathering ?? 0,
          {
            starts_at: input.starts_at ?? "",
            if_schedule_version: input.if_schedule_version,
          },
          ipHash,
        )),
        notice: GATHERING_NOTICE,
      };
    case "session": {
      const r = await setSession(caller, where, input, ipHash);
      return withVisit(r, await nextVisitAfterCommit(caller.botId));
    }
    case "end": {
      const r = await endSession(caller, where, ipHash);
      return withVisit(r, await nextVisitAfterCommit(caller.botId));
    }
    case "answer": {
      const r =
        input.occurrence !== undefined && input.event !== undefined
          ? await answerOccurrence(
              caller,
              where,
              {
                event: input.event,
                occurrence: input.occurrence,
                coming: input.coming ?? true,
              },
              ipHash,
            )
          : await answerSession(caller, where, input, ipHash);
      return withVisit(r, await nextVisitAfterCommit(caller.botId));
    }
  }
}
