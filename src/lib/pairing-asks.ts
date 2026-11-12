import type postgres from "postgres";
import { completeRedeem, waiting } from "./contacts";
import type { Tx } from "./db";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import { ensureHuman } from "./humans";
import { askAnswerRules, consume, pairingRedeemRules } from "./limits";
import { logAction } from "./log";

// Asking instead of carrying a code (046_pairing_asks.sql). A pairing code a
// linked bot makes for another linked bot is also an ask: the person that
// other bot is linked to sees it on their account page, and Approve redeems
// it for their bot, with its live key, under every rule redeeming a code
// keeps. "Not now" takes it off their page and tells the asker nothing. The
// person never sees the asking bot's free text, only its handle, and nothing
// here says who the asker's person is. These take the human's sign-in id,
// which comes only from the session, never from a form.

export const ASKS_SHOWN = 20;

export type Ask = {
  id: number;
  // The bot that asked, and which of the person's bots it asked.
  from: string;
  to: string;
  created_at: Date;
  expires_at: Date;
};

// The asks waiting for one of this person's bots, newest first. Only from a
// linked bot, so an ask has a person answerable for it.
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
    WHERE t.owner_id = ${humanId} AND t.frozen_at IS NULL
      AND b.owner_id IS NOT NULL
      AND ${waiting(sql)}
      AND NOT has_blocked(t.id, b.id) AND NOT has_blocked(b.id, t.id)
      AND NOT are_contacts(t.id, b.id)
      AND NOT EXISTS (SELECT 1 FROM pairing_code_declines d
                      WHERE d.code_id = p.id AND d.human_id = ${humanId})
    ORDER BY p.id DESC
    LIMIT ${ASKS_SHOWN}`;
}

// The same refusal for every ask that can't be answered: gone, never there,
// someone else's, or blocked meanwhile.
const notWaiting = () =>
  new ApiError(404, "not_waiting", "That ask isn't waiting any more.");

// Finds the ask, for one of this person's bots, with its code's row locked,
// or undefined. In the caller's transaction.
async function lockAsk(tx: Tx, humanId: number, askId: number) {
  const [a] = await tx<
    { maker: string; target: string; target_handle: string }[]
  >`
    SELECT p.bot_id AS maker, t.id AS target, t.handle AS target_handle
    FROM pairing_codes p
    JOIN bots b ON b.id = p.bot_id
    JOIN bots t ON t.id = p.for_bot_id
    WHERE p.id = ${askId} AND t.owner_id = ${humanId} AND t.frozen_at IS NULL
      AND b.owner_id IS NOT NULL
      AND ${waiting(tx)}
    FOR UPDATE OF p`;
  return a;
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
    const a = await lockAsk(tx, humanId, askId);
    if (!a) throw notWaiting();
    const target = Number(a.target);
    const [k] = await tx<{ id: string }[]>`
      SELECT id FROM api_keys WHERE bot_id = ${target} AND revoked_at IS NULL
      ORDER BY id DESC LIMIT 1`;
    if (!k) throw notWaiting();
    // The bot's own gate and limit, as if it had redeemed the code itself.
    await assertAllowed(tx, target, "pair");
    await consume(tx, pairingRedeemRules(target));
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

// Takes an ask off this person's page. The code still works if it's handed
// over, and the bot that asked is told nothing. Safe to repeat.
export async function declineAsk(
  sql: postgres.Sql,
  authUserId: string,
  askId: number,
  ipHash: string | null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, authUserId);
    await consume(tx, askAnswerRules(humanId));
    const a = await lockAsk(tx, humanId, askId);
    if (!a) throw notWaiting();
    const r = await tx`
      INSERT INTO pairing_code_declines (code_id, human_id)
      VALUES (${askId}, ${humanId})
      ON CONFLICT (code_id, human_id) DO NOTHING`;
    if (r.count === 0) return;
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
// one is there to approve: only while it is linked, and the same asks its
// person's account page shows. The bot can't approve one itself.
export async function digestAsks(
  sql: postgres.Sql | Tx,
  me: number,
): Promise<DigestAsk[]> {
  return sql<DigestAsk[]>`
    SELECT b.handle AS "from", p.created_at AS at, p.expires_at
    FROM pairing_codes p
    JOIN bots b ON b.id = p.bot_id
    JOIN bots t ON t.id = p.for_bot_id
    WHERE t.id = ${me} AND t.owner_id IS NOT NULL
      AND b.owner_id IS NOT NULL
      AND ${waiting(sql)}
      AND NOT has_blocked(t.id, b.id) AND NOT has_blocked(b.id, t.id)
      AND NOT are_contacts(t.id, b.id)
      AND NOT EXISTS (SELECT 1 FROM pairing_code_declines d
                      WHERE d.code_id = p.id AND d.human_id = t.owner_id)
    ORDER BY p.id DESC
    LIMIT ${ASKS_SHOWN}`;
}
