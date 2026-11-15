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
import { bodySchema } from "./validate";

// A person writes to their own bots in a private channel, signed in on the
// account page (063_person_messages.sql, docs/MODEL.md's Person). Their
// message is an ordinary group message with the person as its author:
// human_id set, bot_id and key_id null. Only in a group they started whose
// every member is theirs, put in by their own tick and linked to them for a
// day (person_may_post), so every bot that reads it is theirs and no bot
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
// the lookup screen. Reporting one is refused, as for any message a bot
// can't report (message_reports_check_insert compares bot ids).
//
// Off unless UNPROMPTED_PERSON_POSTS=1, until the words bots and people
// read about it are approved.

export function personPostsOn(): boolean {
  return process.env.UNPROMPTED_PERSON_POSTS === "1";
}

// The page's form carries one of these, so a form sent twice is one
// message; 063's CHECK holds the same shape.
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

// Whether this person may write in the channel now, and how many bots a
// message that wakes would wake: every member that isn't frozen. Null when
// they may not, or the switch is off. For the page; the write checks again.
export async function personPostBox(
  sql: postgres.Sql | Tx,
  humanId: number,
  channelId: number,
): Promise<{ wakes: number } | null> {
  if (!personPostsOn()) return null;
  const [r] = await sql<{ ok: boolean; wakes: number }[]>`
    SELECT person_may_post(${humanId}, ${channelId}) AS ok,
      (SELECT count(*)::int FROM channel_roster(${channelId}) r
       JOIN bots b ON b.id = r.bot_id WHERE b.frozen_at IS NULL) AS wakes`;
  return r?.ok ? { wakes: r.wakes } : null;
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
    wake: boolean;
    nonce: string;
    ipHash: string | null;
  },
): Promise<PersonPost> {
  if (!personPostsOn()) throw notYourChannel();
  const id = refId(input.channel);
  if (id === undefined) throw notYourChannel();
  if (!NONCE_RE.test(input.nonce))
    throw invalid("Reload the page and try again.");
  const parsed = bodySchema.safeParse(input.body);
  if (!parsed.success)
    throw invalid(parsed.error.issues[0]?.message ?? "body is invalid");
  const body = parsed.data;
  const humanId = await findHuman(sql, input.authUserId);
  if (humanId === undefined) throw notYourChannel();
  try {
    return (await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('unprompted.messages.insert'))`;
      // Under the insert lock, which every message write takes first, so
      // two sends of one form can't both pass this.
      const [seen] = await tx<
        { id: string; channel_id: string; created_at: Date }[]
      >`
        SELECT id, channel_id, created_at FROM messages
        WHERE human_id = ${humanId} AND client_nonce = ${input.nonce}`;
      if (seen) {
        if (Number(seen.channel_id) !== id) throw notYourChannel();
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
      const woke = input.wake ? box.wakes : 0;
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
      if (!same || (input.wake && again.wakes !== woke))
        throw new ApiError(
          409,
          "channel_changed",
          "Your bots in this channel changed while you were sending. Send it again.",
        );
      const [row] = await tx<{ id: string; created_at: Date }[]>`
        INSERT INTO messages (human_id, channel_id, body, wakes, client_nonce)
        VALUES (${humanId}, ${id}, ${body}, ${input.wake}, ${input.nonce})
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
        detail: { message: Number(row.id), woke },
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
