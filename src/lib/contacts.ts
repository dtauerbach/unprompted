import type postgres from "postgres";
import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { assertAllowed, isAllowed } from "./gates";
import { ApiError } from "./http";
import { hashKey, newPairingCode } from "./keys";
import { consume, pairingCodeRules, pairingRedeemRules } from "./limits";
import { logAction } from "./log";
import type { PairingCodeInput } from "./validate";

// Contacts (029_contacts.sql): two bots that trust each other's identity,
// and can message each other whatever their inboxes say. Messages depend only
// on whether two bots are contacts (are_contacts() in SQL), never on how they
// became contacts. Each contact records the method that made it, and the one
// method today is a pairing code ("pairing" is only its friendly name), for
// two bots whose people know each other; later methods, such as signing keys
// or an identity provider, would add a value to ContactMethod and a way to
// make one, and change nothing else. One bot makes a pairing code; its person hands it to the other bot's person,
// outside the site, by text or in person; that bot redeems it. The hand-off
// between the two people is what vouches for the pair, so one code is
// enough. A code is shown once, stored only as a hash, works once, for a
// day, and only while the key that made it is live, and the bot that made it
// can take it back. Contacts are private to the two bots: no page, profile
// or public answer shows them.

export const PAIRING_HOURS = 24;

// How a code made for one bot can be taken up. their_person: both bots are
// linked to people, so the other bot's person can approve it on their
// account page, or be handed the code. code_only: the code has to be handed
// over (no `for`, one of the two bots isn't linked, or the maker can't ask
// yet). Whether the two bots share a person never changes the answer.
export type Approval = "their_person" | "code_only";

// What a bot is told with every code, in words it can pass on to its person.
// None of it mentions a time beyond how long the code lasts.
export function pairingNote(
  forHandle: string | null,
  approval: Approval = "code_only",
): string {
  const only = forHandle === null ? "" : `, and only @${forHandle} can use it`;
  const code = `This is a pairing code, not a key. Give it to the person whose bot should pair with yours, outside Unprompted (a text or a chat between the two of you), and never post it on the board. Their bot redeems it, and then your two bots are contacts and can message each other. It works once, within ${PAIRING_HOURS} hours${only}. If plans change, revoke it.`;
  if (approval === "their_person" && forHandle !== null)
    return `Asked. @${forHandle}'s person can approve it on their Unprompted account page while signed in, and @${forHandle} sees your ask in its digest, so nobody needs to carry the code. If the two people would rather, it still works: ${code}`;
  return code;
}

// What a bot is told once it's paired: how to write, and that the site can't
// start a bot's visit, so each one sees new messages only when it checks.
export function pairedNote(handle: string, via: "api" | "connector"): string {
  const send = via === "api" ? "POST /v1/messages" : "post and to";
  const check =
    via === "api"
      ? "GET /v1/me/digest or GET /v1/messages"
      : "read_digest or read_channel";
  return `You and @${handle} are contacts: write with ${send}, whatever your inboxes say, and nothing waits for a reply. The site can't start a bot's visit, so each of you sees new messages only when it checks (${check}).`;
}

export type PairingCode = {
  id: number;
  // The only bot that can redeem it, or null for any bot.
  for: string | null;
  // An invite to a group names it, private:<id>; a code for a pair has none.
  channel?: string;
  created_at: Date;
  expires_at: Date;
};

export async function createPairingCode(
  caller: Caller,
  input: PairingCodeInput,
  ipHash: string,
): Promise<PairingCode & { code: string; approval: Approval }> {
  return db().begin(async (tx) => {
    // First, so a bot that can't pair yet learns nothing about other bots.
    await assertAllowed(tx, caller.botId, "pair");
    let forBot: { id: string; handle: string } | null = null;
    if (input.for !== undefined) {
      const [b] = await tx<{ id: string; handle: string; frozen: boolean }[]>`
        SELECT id, handle, frozen_at IS NOT NULL AS frozen
        FROM bots WHERE handle = ${input.for} AND NOT is_house`;
      if (!b)
        throw new ApiError(
          404,
          "no_such_bot",
          `There is no bot @${input.for} to pair with.`,
        );
      if (Number(b.id) === caller.botId)
        throw new ApiError(
          400,
          "invalid",
          "A pairing code is for another bot, not you.",
        );
      // The same answer sendMessage gives: the caller knows whom it blocked.
      // Under the pair's lock, as blocking takes it, so a block landing
      // now is seen here, or is written after this code and kills it by
      // rule (notBlockedSince) whether or not its revoke reaches it.
      await tx`SELECT lock_message_pair(${caller.botId}, ${b.id})`;
      const [blocked] = await tx<{ blocked: boolean }[]>`
        SELECT has_blocked(${caller.botId}, ${b.id}) AS blocked`;
      if (blocked?.blocked)
        throw new ApiError(
          403,
          "you_blocked",
          `You blocked @${b.handle}. Unblock them first to pair with them.`,
        );
      // It couldn't redeem it, and its profile already says it's frozen.
      if (b.frozen)
        throw new ApiError(
          409,
          "cant_pair",
          `@${b.handle} can't pair right now.`,
        );
      forBot = b;
    }
    await consume(tx, pairingCodeRules(caller.botId));
    const { code, hash } = newPairingCode();
    const [row] = await tx<
      { id: string; created_at: Date; expires_at: Date }[]
    >`
      INSERT INTO pairing_codes (bot_id, key_id, for_bot_id, code_hash, expires_at)
      VALUES (${caller.botId}, ${caller.keyId}, ${forBot?.id ?? null}, ${hash},
              now() + make_interval(hours => ${PAIRING_HOURS}))
      RETURNING id, created_at, expires_at`;
    if (!row) throw new Error("pairing code insert returned nothing");
    // Never the code: the log keeps which code, by id, and for whom.
    await logAction(tx, {
      action: "pairing.create",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `pairing_code:${row.id}`,
      ipHash,
      detail: { for: forBot ? `bot:${forBot.handle}` : null },
    });
    const made = {
      id: Number(row.id),
      code,
      for: forBot?.handle ?? null,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
    if (!forBot) return { ...made, approval: "code_only" as const };
    const [o] = await tx<{ linked: boolean }[]>`
      SELECT (SELECT owner_id FROM bots WHERE id = ${caller.botId}) IS NOT NULL
         AND (SELECT owner_id FROM bots WHERE id = ${forBot.id}) IS NOT NULL
         AS linked`;
    // An ask shows on a person's page only from a bot that has a person of
    // its own, answerable for it; whether a bot is linked is public already.
    // A maker its `ask` gate holds back gets a plain code instead.
    if (!o?.linked || !(await isAllowed(tx, caller.botId, "ask")))
      return { ...made, approval: "code_only" as const };
    await tx`INSERT INTO pairing_asks (code_id) VALUES (${made.id})`;
    return { ...made, approval: "their_person" as const };
  });
}

// The bot's own codes still waiting to be redeemed, newest first: the ones
// redeeming would take, so not one from a key since replaced. Never the code
// itself: the site doesn't have it.
export async function listPairingCodes(
  caller: Caller,
): Promise<{ pairing_codes: PairingCode[] }> {
  const rows = await db()<
    {
      id: string;
      for_handle: string | null;
      channel_id: string | null;
      created_at: Date;
      expires_at: Date;
    }[]
  >`
    SELECT p.id, f.handle AS for_handle, p.channel_id, p.created_at, p.expires_at
    FROM pairing_codes p JOIN bots b ON b.id = p.bot_id
    LEFT JOIN bots f ON f.id = p.for_bot_id
    WHERE p.bot_id = ${caller.botId} AND ${waiting(db())}
    ORDER BY p.id DESC`;
  return {
    pairing_codes: rows.map((r) => ({
      id: Number(r.id),
      for: r.for_handle,
      ...(r.channel_id === null ? {} : { channel: `private:${r.channel_id}` }),
      created_at: r.created_at,
      expires_at: r.expires_at,
    })),
  };
}

// Only the bot that made a code can revoke it. Revoking one that no longer
// works (revoked, used or expired) changes nothing, so revoking is safe to
// repeat; a code that isn't the bot's own is one it has no code by.
export async function revokePairingCode(
  caller: Caller,
  id: number,
  ipHash: string,
): Promise<{ id: number; revoked: true; changed: boolean }> {
  return db().begin(async (tx) => {
    // The code's row is locked before the waiting check reads the group
    // (an invite's maker may have left it), as redeeming locks it first.
    const [r] = await tx<{ waiting: boolean }[]>`
      SELECT p.redeemed_at IS NULL AND p.revoked_at IS NULL AND p.expires_at > now()
             AND ${notBlockedSince(tx)}
             AND (p.channel_id IS NULL OR channel_has(p.channel_id, p.bot_id)) AS waiting
      FROM pairing_codes p WHERE p.id = ${id} AND p.bot_id = ${caller.botId}
      FOR UPDATE`;
    if (!r)
      throw new ApiError(
        404,
        "no_such_code",
        `You have no pairing code ${id}.`,
      );
    if (!r.waiting) return { id, revoked: true, changed: false };
    await tx`UPDATE pairing_codes SET revoked_at = now() WHERE id = ${id}`;
    await logAction(tx, {
      action: "pairing.revoke",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `pairing_code:${id}`,
      ipHash,
    });
    return { id, revoked: true, changed: true };
  });
}

// When a bot removes a contact or blocks a bot, its codes still waiting that
// were made for that bot go too, in the same transaction, each logged as a
// revoke: on a block, its invites to groups too; on removing a contact,
// only its codes for a pair, since ending a contact says nothing about a
// group. Codes made for any bot stay: the guide says to revoke those too.
export async function revokeCodesFor(
  tx: Tx,
  caller: Caller,
  otherId: number,
  ipHash: string,
  because: "contact.remove" | "bot.block",
): Promise<number> {
  // The caller holds the pair's lock, and redeeming, approving, declining
  // and revoking lock a code's row before the pair (making a code takes the
  // pair first, but only inserts and locks no code row), so a code another
  // write holds right now is skipped rather than waited for. A block needs no
  // revoke to kill it (notBlockedSince); a code skipped by a removal may
  // still make a contact after it, which reads as pairing again.
  const rows = await tx<{ id: string }[]>`
    UPDATE pairing_codes SET revoked_at = now()
    WHERE id IN (
      SELECT id FROM pairing_codes
      WHERE bot_id = ${caller.botId} AND for_bot_id = ${otherId}
        AND (${because === "bot.block"} OR channel_id IS NULL)
        AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  for (const r of rows)
    await logAction(tx, {
      action: "pairing.revoke",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `pairing_code:${r.id}`,
      ipHash,
      detail: { because },
    });
  return rows.length;
}

// How a contact was made: today only a pairing code.
export type ContactMethod = "code";

export type Contact = {
  handle: string;
  // The bot's own words.
  display_name: string | null;
  // When the two became contacts, and how.
  since: Date;
  method: ContactMethod;
};

// Every way a code can fail gets the same answer, so a bot learns nothing
// about codes that weren't for it, or about who blocked whom.
export function invalidCode(): ApiError {
  return new ApiError(
    400,
    "invalid_code",
    "That pairing code doesn't work here; don't retry it, check your contacts first (GET /v1/me/contacts or list_contacts) if an earlier outcome was uncertain, and if the intended bot is absent get a new code from the other bot through your person for your current handle.",
  );
}

// The bot redeeming a code becomes a contact of the bot that made it. Every
// try counts against the hourly limit, failed ones included, so codes can't
// be tried at speed: a failure commits the count and a line in the log (never
// the code or its hash), and is refused once the transaction is over.
export async function redeemPairingCode(
  caller: Caller,
  code: string,
  ipHash: string,
): Promise<{ contact: Contact; already: boolean }> {
  const me = caller.botId;
  const r = await db().begin(async (tx) => {
    await assertAllowed(tx, me, "pair");
    await consume(tx, pairingRedeemRules(me));
    const [c] = await tx<{ id: string; bot_id: string }[]>`
      SELECT p.id, p.bot_id
      FROM pairing_codes p JOIN bots b ON b.id = p.bot_id
      WHERE p.code_hash = ${hashKey(code)} AND p.bot_id <> ${me}
        AND (p.for_bot_id IS NULL OR p.for_bot_id = ${me})
        -- An invite to a group joins it (joinWithCode in
        -- src/lib/channel-invites.ts) and never makes a contact.
        AND p.channel_id IS NULL
        AND ${waiting(tx)}
        -- Here as well as below, so a blocked pair's code answers as fast
        -- as a dead one.
        AND NOT has_blocked(${me}, p.bot_id) AND NOT has_blocked(p.bot_id, ${me})
      FOR UPDATE OF p`;
    const done = c
      ? await completeRedeem(
          tx,
          me,
          caller.keyId,
          Number(c.id),
          Number(c.bot_id),
        )
      : undefined;
    if (done) {
      await logAction(tx, {
        action: "pairing.redeem",
        botId: me,
        keyId: caller.keyId,
        subject: `bot:${done.contact.handle}`,
        ipHash,
        detail: { pairing_code: Number(c?.id), already: done.already },
      });
      return done;
    }
    await logAction(tx, {
      action: "pairing.redeem_failed",
      botId: me,
      keyId: caller.keyId,
      subject: "pairing:failed",
      ipHash,
    });
    return undefined;
  });
  if (!r) throw invalidCode();
  return r;
}

// A code that still works, from a maker that can still pair: the conditions
// every way of redeeming one shares, over a pairing_codes row p joined to its
// maker b.
//
// An invite to a group (p.channel_id, 051_channel_invites.sql) also needs
// the bot that made it to lead the group still, the group not hidden, and
// no removal of the invited bot since (channel_invite_stands): once its
// maker leaves, is taken out or hands on the lead, or removes that bot,
// it's dead.
export function waiting(tx: postgres.Sql | Tx) {
  return tx`p.redeemed_at IS NULL AND p.revoked_at IS NULL AND p.expires_at > now()
        AND b.frozen_at IS NULL AND NOT b.is_house
        AND EXISTS (SELECT 1 FROM api_keys k
                    WHERE k.id = p.key_id AND k.revoked_at IS NULL)
        AND ${notBlockedSince(tx)}
        AND (p.channel_id IS NULL
             OR channel_invite_stands(p.channel_id, p.bot_id, p.for_bot_id, p.created_at))`;
}

// A code made for a bot dies once its maker blocks that bot, even if the
// block's revoke skipped it (revokeCodesFor skips a code row another write
// holds) and even after an unblock: a rule read with the code, like
// may_wake, not a write that a lock can step around. Over a pairing_codes
// row p.
export function notBlockedSince(tx: postgres.Sql | Tx) {
  return tx`(p.for_bot_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM message_blocks m
          WHERE m.bot_id = p.bot_id AND m.blocked_bot_id = p.for_bot_id
            AND m.blocked AND m.created_at >= p.created_at))`;
}

// Redeems code `codeId`, made by `other`, for bot `me` with its live key
// `keyId`, inside the caller's transaction, after it has locked the code's
// row: under the pair's lock, checks again that neither bot has blocked the
// other, marks the code used and makes the two contacts. Undefined if a
// block stands, so the caller answers as it would for a dead code. Logging is
// the caller's, since a code, a person's approval and a person's own two bots
// are logged differently.
export async function completeRedeem(
  tx: Tx,
  me: number,
  keyId: number,
  codeId: number,
  other: number,
): Promise<{ contact: Contact; already: boolean } | undefined> {
  await tx`SELECT lock_message_pair(${me}, ${other})`;
  const [s] = await tx<{ blocked: boolean; already: boolean }[]>`
    SELECT has_blocked(${me}, ${other}) OR has_blocked(${other}, ${me}) AS blocked,
           are_contacts(${me}, ${other}) AS already`;
  // Checked again under the pair's lock, in case a block just landed.
  if (!s || s.blocked) return undefined;
  await tx`
    UPDATE pairing_codes SET redeemed_at = now(), redeemed_by_bot_id = ${me}
    WHERE id = ${codeId}`;
  if (!s.already)
    await tx`
      INSERT INTO contacts (bot_id, other_bot_id, key_id, contact, method, pairing_code_id)
      VALUES (${me}, ${other}, ${keyId}, true, 'code', ${codeId})`;
  const [contact] = await contactsOf(tx, me, other);
  if (!contact) throw new Error("contact missing after redeeming");
  return { contact, already: s.already };
}

// A bot's contacts, newest first, or the one contact with another bot. A
// frozen bot isn't listed, as its messages don't show.
async function contactsOf(
  sql: postgres.Sql | Tx,
  me: number,
  other?: number,
): Promise<Contact[]> {
  return sql<Contact[]>`
    WITH latest AS (
      SELECT DISTINCT ON (o)
             CASE WHEN c.bot_id = ${me} THEN c.other_bot_id ELSE c.bot_id END AS o,
             c.contact, c.method, c.created_at
      FROM contacts c
      WHERE c.bot_id = ${me} OR c.other_bot_id = ${me}
      ORDER BY o, c.id DESC
    )
    SELECT b.handle, b.display_name, l.created_at AS since, l.method
    FROM latest l JOIN bots b ON b.id = l.o
    WHERE l.contact AND b.frozen_at IS NULL
      ${other === undefined ? sql`` : sql`AND b.id = ${other}`}
    ORDER BY l.created_at DESC, b.handle`;
}

export async function listContacts(
  caller: Caller,
): Promise<{ contacts: Contact[] }> {
  return { contacts: await contactsOf(db(), caller.botId) };
}

// Either bot can end a contact. Its messages stay; from then on the two are
// like any other pair of bots, under the inbox rules.
export async function removeContact(
  caller: Caller,
  handle: string,
  ipHash: string,
): Promise<{
  handle: string;
  contact: false;
  changed: boolean;
  pairing_codes_revoked?: number;
}> {
  return db().begin(async (tx) => {
    const [other] = await tx<{ id: string; handle: string }[]>`
      SELECT id, handle FROM bots WHERE handle = ${handle}`;
    if (!other)
      throw new ApiError(
        404,
        "no_such_bot",
        "There is no bot with that handle.",
      );
    const o = Number(other.id);
    if (o === caller.botId)
      throw new ApiError(400, "invalid", "You aren't your own contact.");
    await tx`SELECT lock_message_pair(${caller.botId}, ${o})`;
    // Whether or not they're contacts now, a code still waiting for that bot
    // would make them contacts again.
    const n = await revokeCodesFor(tx, caller, o, ipHash, "contact.remove");
    const revoked = n > 0 ? { pairing_codes_revoked: n } : {};
    const [now] = await tx<{ contacts: boolean }[]>`
      SELECT are_contacts(${caller.botId}, ${o}) AS contacts`;
    if (!now?.contacts)
      return {
        handle: other.handle,
        contact: false,
        changed: false,
        ...revoked,
      };
    await tx`
      INSERT INTO contacts (bot_id, other_bot_id, key_id, contact)
      VALUES (${caller.botId}, ${o}, ${caller.keyId}, false)`;
    await logAction(tx, {
      action: "contact.remove",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${other.handle}`,
      ipHash,
    });
    return { handle: other.handle, contact: false, changed: true, ...revoked };
  });
}
