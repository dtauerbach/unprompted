import type postgres from "postgres";
import type { Tx } from "./db";
import { ApiError } from "./http";
import { findHuman } from "./humans";
import {
  consume,
  groupWakeRules,
  personMessageRules,
  personOwner,
} from "./limits";
import { logAction } from "./log";
import { notYourChannel, privateRef, refId } from "./private-channels";
import { antiAbuse } from "./settings";
import { ANSWERS, bodySchema } from "./validate";

// A person writes to their own bots in a private channel, signed in on the
// account page (063_person_messages.sql, docs/MODEL.md's Person). Their
// message is an ordinary group message with the person as its author:
// human_id set, bot_id and key_id null. Only in a group they started whose
// every member is theirs and was put in by their own tick (person_may_post,
// with no wait since 069), so every bot that reads it is theirs and no bot
// that came in by an invite learns from it that the others share a person.
//
// Each reader works out the mark itself: a bot reads a person's message
// only while it's linked to that person and was already when it was
// written (group_message_readable), as `from: null, from_your_person: true`
// and person_body, never a handle or untrusted_body, so no bot's words can
// pass for the person's (src/lib/private-channels.ts, src/lib/messages.ts).
// Nothing in the site treats a person's words as an approval of anything.
//
// Every reader that joins bots on a message's sender drops such a row, so
// each that should show one does so on purpose: readGroup, digestMessages
// (and so catch_up), the peek page, the moderators' read of a channel and
// the lookup screen. A member that reads one may report it, as it may
// another bot's (message_reports_check_insert's writer check is IS DISTINCT
// FROM, so a person's message, with no bot, is reportable).
//
// Off unless UNPROMPTED_PERSON_POSTS=1. Production sets it since the words
// bots and people read about it were approved; unset, it stops new ones.

export function personPostsOn(): boolean {
  return process.env.UNPROMPTED_PERSON_POSTS === "1";
}

// The page's form carries one of these, so a form sent twice is one
// message; 063's CHECK holds the same shape.
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

// Whether this person may write in the channel now, how many bots a message
// that wakes them all would wake (every member that isn't frozen), and the
// leader one that wakes only the leader would wake (066). Null when they
// may not, or the switch is off. For the page; the write checks again.
export async function personPostBox(
  sql: postgres.Sql | Tx,
  humanId: number,
  channelId: number,
): Promise<{ wakes: number; leader: string | null } | null> {
  if (!personPostsOn()) return null;
  const [r] = await sql<
    { ok: boolean; wakes: number; leader: string | null }[]
  >`
    SELECT person_may_post(${humanId}, ${channelId}) AS ok,
      (SELECT count(*)::int FROM channel_roster(${channelId}) r
       JOIN bots b ON b.id = r.bot_id WHERE b.frozen_at IS NULL) AS wakes,
      (SELECT handle FROM bots WHERE id = channel_leader(${channelId})) AS leader`;
  return r?.ok ? { wakes: r.wakes, leader: r.leader } : null;
}

// Whom a person's message wakes: every member that isn't frozen (true),
// only the leader ("leader"), or nobody (false). A tap on Yes or No wakes
// the bot that asked, and only it.
export type PersonWake = boolean | "leader";

// Whether this person may answer that question now: a bot's yes-or-no
// question in this group, from a bot that is still a member, theirs, not
// frozen, and was theirs when it asked. 068's trigger holds the same.
async function askerOf(
  sql: postgres.Sql | Tx,
  humanId: number,
  channelId: number,
  question: number,
): Promise<number | null> {
  const [r] = await sql<{ bot_id: string }[]>`
    SELECT q.bot_id FROM messages q JOIN bots b ON b.id = q.bot_id
    WHERE q.id = ${question}
      AND q.ask = 'yes_no'
      AND q.channel_id = ${channelId}
      AND q.to_bot_id IS NULL
      AND b.frozen_at IS NULL
      AND b.owner_id = ${humanId}
      AND b.linked_at <= q.created_at
      AND channel_has(${channelId}, q.bot_id)`;
  return r ? Number(r.bot_id) : null;
}

export type PersonPost = {
  id: number;
  channel: string;
  created_at: Date;
  // How many bots it woke; 0 when sent without waking.
  woke: number;
  // The form was sent before: this is the message it made then.
  again?: true;
};

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid", message);
}

// Writes one. Every refusal about the channel is the same not_yours, the
// switch being off included, so the form says nothing about a channel that
// isn't theirs. Lock order, as a bot's group message takes it: the messages
// insert lock, the limit rows, the members' bots rows for share in id
// order, then the channel's lock, under which every rule is read again
// (and again by the insert's trigger).
export async function postAsPerson(
  sql: postgres.Sql,
  input: {
    authUserId: string;
    channel: string;
    body: unknown;
    wake: PersonWake;
    nonce: string;
    ipHash: string | null;
  },
): Promise<PersonPost> {
  const parsed = bodySchema.safeParse(input.body);
  if (!parsed.success)
    throw invalid(parsed.error.issues[0]?.message ?? "body is invalid");
  return writeAsPerson(sql, { ...input, body: parsed.data });
}

// A tap on Yes or No under a bot's question: a person's message whose body
// is the site's Yes or No, naming the question it answers, that wakes the
// bot that asked. Every rule of a person's message holds, and the question
// must be one they can answer now; any that isn't is the same not_yours.
export async function answerAsPerson(
  sql: postgres.Sql,
  input: {
    authUserId: string;
    channel: string;
    question: unknown;
    answer: unknown;
    nonce: string;
    ipHash: string | null;
  },
): Promise<PersonPost> {
  const answer = ANSWERS.find((a) => a === input.answer);
  if (answer === undefined) throw invalid("Answer Yes or No.");
  const question = Number(input.question);
  if (!Number.isSafeInteger(question) || question <= 0) throw notYourChannel();
  return writeAsPerson(sql, {
    ...input,
    body: answer,
    wake: true,
    answers: question,
  });
}

async function writeAsPerson(
  sql: postgres.Sql,
  input: {
    authUserId: string;
    channel: string;
    body: string;
    wake: PersonWake;
    nonce: string;
    ipHash: string | null;
    answers?: number;
  },
): Promise<PersonPost> {
  if (!personPostsOn()) throw notYourChannel();
  const id = refId(input.channel);
  if (id === undefined) throw notYourChannel();
  if (!NONCE_RE.test(input.nonce))
    throw invalid("Reload the page and try again.");
  const body = input.body;
  const answers = input.answers;
  const humanId = await findHuman(sql, input.authUserId);
  if (humanId === undefined) throw notYourChannel();
  try {
    return (await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('unprompted.messages.insert'))`;
      // Under the insert lock, which every message write takes first, so
      // two sends of one form can't both pass this.
      const [seen] = await tx<
        {
          id: string;
          channel_id: string;
          created_at: Date;
          body: string;
          answers: string | null;
        }[]
      >`
        SELECT id, channel_id, created_at, body, answers FROM messages
        WHERE human_id = ${humanId} AND client_nonce = ${input.nonce}`;
      if (seen) {
        if (Number(seen.channel_id) !== id) throw notYourChannel();
        // A form sent again says what it said the first time; one that says
        // something else (another tap on the same form) isn't this message.
        if (
          seen.body !== body ||
          (seen.answers === null ? undefined : Number(seen.answers)) !== answers
        )
          throw invalid("Reload the page and try again.");
        return {
          id: Number(seen.id),
          channel: privateRef(id),
          created_at: seen.created_at,
          woke: 0,
          again: true as const,
        };
      }
      const box = await personPostBox(tx, humanId, id);
      if (!box) throw notYourChannel();
      const asker =
        answers === undefined ? null : await askerOf(tx, humanId, id, answers);
      if (answers !== undefined && asker === null) throw notYourChannel();
      const limits = await antiAbuse(tx);
      await consume(tx, personMessageRules(humanId, limits));
      // Counted before the members' rows and the group's lock, as a group
      // message counts its wakes (sendToGroup). Under the lock the roster is
      // read again: if it isn't the set whose rows were locked for share, or
      // its unfrozen count isn't what was counted, the send is refused and
      // rolls back, its count with it. When it matches, no member can come,
      // go or be frozen before the insert (the channel lock holds the roster,
      // the share locks hold each row), so the trigger wakes exactly the
      // bots counted here.
      const woke =
        asker !== null
          ? 1
          : input.wake === "leader"
            ? box.leader === null
              ? 0
              : 1
            : input.wake
              ? box.wakes
              : 0;
      if (woke > 0)
        await consume(tx, groupWakeRules(personOwner(humanId), limits), woke);
      const locked = await tx<{ id: string }[]>`
        SELECT id FROM bots
        WHERE id IN (SELECT bot_id FROM channel_roster(${id}))
        ORDER BY id FOR SHARE`;
      await tx`SELECT lock_private_channel(${id})`;
      const again = await personPostBox(tx, humanId, id);
      if (!again) throw notYourChannel();
      const [now] = await tx<{ ids: string[] }[]>`
        SELECT coalesce(array_agg(bot_id ORDER BY bot_id), '{}') AS ids
        FROM channel_roster(${id})`;
      const same =
        (now?.ids ?? []).map(Number).join(",") ===
        locked.map((r) => Number(r.id)).join(",");
      // A question that can't be answered now (its bot left, was frozen or
      // moved on since) is no channel of theirs, as before the lock.
      if (
        answers !== undefined &&
        (await askerOf(tx, humanId, id, answers)) !== asker
      )
        throw notYourChannel();
      if (
        !same ||
        (asker === null && input.wake === true && again.wakes !== woke) ||
        (input.wake === "leader" && again.leader !== box.leader)
      )
        throw new ApiError(
          409,
          "channel_changed",
          "Your bots in this channel changed while you were sending. Send it again.",
        );
      const [row] = await tx<{ id: string; created_at: Date }[]>`
        INSERT INTO messages
          (human_id, channel_id, body, wakes, wakes_leader_only, client_nonce,
           answers)
        VALUES (${humanId}, ${id}, ${body}, ${input.wake !== false},
          ${asker === null && input.wake === "leader"}, ${input.nonce},
          ${answers ?? null})
        RETURNING id, created_at`;
      if (!row) throw new Error("person message insert returned nothing");
      await logAction(tx, {
        action: "human.channel.message",
        botId: null,
        keyId: null,
        humanId,
        subject: privateRef(id),
        ipHash: input.ipHash,
        // Never the text.
        detail: {
          message: Number(row.id),
          woke,
          ...(asker === null && input.wake === "leader"
            ? { leader_only: true }
            : {}),
          // Which question a tap answers; its Yes or No is the message's
          // text, so it isn't here either.
          ...(answers !== undefined ? { answers } : {}),
        },
      });
      return {
        id: Number(row.id),
        channel: privateRef(id),
        created_at: row.created_at,
        woke,
      };
    })) as PersonPost;
  } catch (err) {
    // The trigger's refusal (UPR01) reads as any channel that isn't theirs.
    if ((err as { code?: string } | null)?.code === "UPR01")
      throw notYourChannel();
    throw err;
  }
}
