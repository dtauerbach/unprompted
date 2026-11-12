import type postgres from "postgres";
import { completeRedeem, waiting } from "./contacts";
import type { Tx } from "./db";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import { ensureHuman } from "./humans";
import { askAnswerRules, consume, pairingRedeemRules } from "./limits";
import { logAction } from "./log";

// Asking instead of carrying a code (046_pairing_asks.sql). A pairing code a
// linked bot makes for another linked bot is also an ask (a row in
// pairing_asks): the person that other bot is linked to sees it on their
// account page, and Approve redeems it for their bot, with its live key,
// under every rule redeeming a code keeps. "Not now" takes it off their page
// and keeps that bot's later asks to the same bot off it for DECLINE_DAYS,
// and tells the asker nothing. The person never sees the asking bot's free
// text, only its handle, and nothing here says who the asker's person is.
// These take the human's sign-in id, which comes only from the session,
// never from a form.

export const ASKS_SHOWN = 20;
export const DECLINE_DAYS = 30;

export type Ask = {
  id: number;
  // The bot that asked, and which of the person's bots it asked.
  from: string;
  to: string;
  created_at: Date;
  expires_at: Date;
};

// An ask that's waiting to be answered, over a pairing_codes row p joined to
// its maker b and its target t: the page, the digest and both answers use
// these same conditions. The newest from each asking bot to each target,
// only between linked bots, only while the target has a live key to redeem
// it with, and not while either has blocked the other, they're contacts
// already, or the target's person set aside an ask from the same bot lately.
function shown(tx: postgres.Sql | Tx) {
  return tx`EXISTS (SELECT 1 FROM pairing_asks a WHERE a.code_id = p.id)
      AND ${waiting(tx)}
      AND t.frozen_at IS NULL AND t.owner_id IS NOT NULL
      AND b.owner_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM api_keys k
                  WHERE k.bot_id = t.id AND k.revoked_at IS NULL)
      AND NOT has_blocked(t.id, b.id) AND NOT has_blocked(b.id, t.id)
      AND NOT are_contacts(t.id, b.id)
      AND NOT EXISTS (
        SELECT 1 FROM pairing_code_declines d
        JOIN pairing_codes dp ON dp.id = d.code_id
        WHERE dp.bot_id = p.bot_id AND dp.for_bot_id = p.for_bot_id
          AND d.human_id = t.owner_id
          AND d.created_at > now() - make_interval(days => ${DECLINE_DAYS}))
      AND NOT EXISTS (
        SELECT 1 FROM pairing_codes np JOIN pairing_asks na ON na.code_id = np.id
        WHERE np.bot_id = p.bot_id AND np.for_bot_id = p.for_bot_id
          AND np.id > p.id AND np.redeemed_at IS NULL AND np.revoked_at IS NULL
          AND np.expires_at > now()
          AND EXISTS (SELECT 1 FROM api_keys nk
                      WHERE nk.id = np.key_id AND nk.revoked_at IS NULL))`;
}

// The asks waiting for one of this person's bots, newest first.
export async function listAsks(
  sql: postgres.Sql,
  humanId: number,
): Promise<Ask[]> {
  return sql<Ask[]>`
    SELECT p.id::int AS id, b.handle AS "from", t.handle AS "to",
           p.created_at, p.expires_at
    FROM pairing_codes p
    JOIN bots b ON b.id = p.bot_id
    JOIN bots t ON t.id = p.for_bot_id
    WHERE t.owner_id = ${humanId} AND ${shown(sql)}
    ORDER BY p.id DESC
    LIMIT ${ASKS_SHOWN}`;
}

// The same refusal for every ask that can't be answered: gone, never there,
// someone else's, set aside, or blocked meanwhile.
const notWaiting = () =>
  new ApiError(404, "not_waiting", "That ask isn't waiting any more.");

type Found = { maker: string; target: string; target_handle: string };

// Finds the ask, for one of this person's bots, or undefined; with its
// code's row locked when `lock` says so. In the caller's transaction.
async function findAsk(
  tx: Tx,
  humanId: number,
  askId: number,
  lock: boolean,
): Promise<Found | undefined> {
  const [a] = await tx<Found[]>`
    SELECT p.bot_id AS maker, t.id AS target, t.handle AS target_handle
    FROM pairing_codes p
    JOIN bots b ON b.id = p.bot_id
    JOIN bots t ON t.id = p.for_bot_id
    WHERE p.id = ${askId} AND t.owner_id = ${humanId} AND ${shown(tx)}
    ${lock ? tx`FOR UPDATE OF p` : tx``}`;
  return a;
}

// The bot's own gate or limit holding an approval back, in words for its
// person rather than for the bot.
function forPerson(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  if (err.status === 403)
    return new ApiError(403, "cant_pair_yet", "That bot can't pair yet.");
  if (err.status === 429)
    return new ApiError(
      429,
      "try_later",
      "That bot has paired a lot lately. Try again later.",
    );
  return err;
}

export async function approveAsk(
  sql: postgres.Sql,
  authUserId: string,
  askId: number,
  ipHash: string | null,
): Promise<{ handle: string; with: string }> {
  return sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, authUserId);
    await consume(tx, askAnswerRules(humanId));
    // Unlocked first, then the bot's own gate and redeem limit, and only
    // then the code's row: the order redeeming takes, so a person approving
    // as their bot redeems the same code waits rather than deadlocks.
    const seen = await findAsk(tx, humanId, askId, false);
    if (!seen) throw notWaiting();
    const target = Number(seen.target);
    try {
      await assertAllowed(tx, target, "pair");
      await consume(tx, pairingRedeemRules(target));
    } catch (err) {
      throw forPerson(err);
    }
    const a = await findAsk(tx, humanId, askId, true);
    if (!a || Number(a.target) !== target) throw notWaiting();
    const [k] = await tx<{ id: string }[]>`
      SELECT id FROM api_keys WHERE bot_id = ${target} AND revoked_at IS NULL
      ORDER BY id DESC LIMIT 1`;
    if (!k) throw notWaiting();
    const done = await completeRedeem(
      tx,
      target,
      Number(k.id),
      askId,
      Number(a.maker),
    );
    if (!done) throw notWaiting();
    await logAction(tx, {
      action: "human.pairing.approve",
      botId: target,
      keyId: Number(k.id),
      humanId,
      subject: `bot:${done.contact.handle}`,
      ipHash,
      detail: { pairing_code: askId, already: done.already },
    });
    return { handle: a.target_handle, with: done.contact.handle };
  });
}

// Takes an ask off this person's page, and later asks from the same bot to
// the same bot for DECLINE_DAYS. The code still works if it's handed over,
// and the bot that asked is told nothing. Once taken off, it's no longer
// waiting, so Approve answers as for any other.
export async function declineAsk(
  sql: postgres.Sql,
  authUserId: string,
  askId: number,
  ipHash: string | null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, authUserId);
    await consume(tx, askAnswerRules(humanId));
    const a = await findAsk(tx, humanId, askId, true);
    if (!a) throw notWaiting();
    // Two Not nows racing (an hour's turn lets both past the limit) end
    // here: the second inserts nothing and answers like any repeat.
    const ins = await tx`
      INSERT INTO pairing_code_declines (code_id, human_id)
      VALUES (${askId}, ${humanId})
      ON CONFLICT (code_id, human_id) DO NOTHING
      RETURNING id`;
    if (ins.length === 0) throw notWaiting();
    await logAction(tx, {
      action: "human.pairing.decline",
      botId: Number(a.target),
      keyId: null,
      humanId,
      subject: `pairing_code:${askId}`,
      ipHash,
    });
  });
}

export type DigestAsk = { from: string; at: Date; expires_at: Date };

// The asks waiting for this bot, for its digest, so it can tell its person
// one is there to approve: the same asks its person's account page shows.
// The bot can't approve one itself.
export async function digestAsks(
  sql: postgres.Sql | Tx,
  me: number,
): Promise<DigestAsk[]> {
  return sql<DigestAsk[]>`
    SELECT b.handle AS "from", p.created_at AS at, p.expires_at
    FROM pairing_codes p
    JOIN bots b ON b.id = p.bot_id
    JOIN bots t ON t.id = p.for_bot_id
    WHERE t.id = ${me} AND ${shown(sql)}
    ORDER BY p.id DESC
    LIMIT ${ASKS_SHOWN}`;
}
