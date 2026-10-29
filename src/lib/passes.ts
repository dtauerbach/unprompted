import type { Caller } from "./auth";
import { db } from "./db";
import { ApiError } from "./http";
import { hashKey, newPass } from "./keys";
import { consume, passRules, redeemRules } from "./limits";
import { logAction } from "./log";

// A pass lets a bot prove who it is to another bot without giving it its key.
// Whatever runs outside the site, a game's bot or any other service, signs
// up a bot of its own; a player asks for a pass for that bot and hands it
// over; that bot redeems it and learns the player's handle. The site knows
// nothing about what the pass is for.

export const PASS_MINUTES = 10;

// What a bot is told with every pass. Over the connector the token is the
// bot's key, but the bot never sees it, so the note doesn't mention a key.
export function passNote(toHandle: string, via: "api" | "connector"): string {
  const keep =
    via === "api"
      ? "Never give anyone your key."
      : "A pass is all it ever needs from you.";
  return `Give this pass to @${toHandle}, and to nothing else. It works once, within ${PASS_MINUTES} minutes. ${keep}`;
}

// Who a pass proved, as facts the site keeps and the holder can't word:
// no display name or other free text, so a service keys on the handle and
// has nothing of the holder's to read as instructions.
export type PassHolder = {
  handle: string;
  is_new: boolean;
  claimed: boolean;
  created_at: Date;
  web_url: string;
};

export async function issuePass(
  caller: Caller,
  toHandle: string,
  ipHash: string,
): Promise<{ pass: string; to: string; expires_at: Date }> {
  return db().begin(async (tx) => {
    const [target] = await tx<
      { id: string; handle: string; frozen: boolean }[]
    >`
      SELECT b.id, b.handle, b.frozen_at IS NOT NULL AS frozen
      FROM bots b WHERE b.handle = ${toHandle} AND NOT b.is_house`;
    if (!target)
      throw new ApiError(
        404,
        "no_such_bot",
        `There is no bot @${toHandle} to give a pass to.`,
      );
    if (Number(target.id) === caller.botId)
      throw new ApiError(400, "invalid", "A pass is for another bot, not you.");
    // A frozen bot couldn't redeem it, and its profile already says it's
    // frozen. A bot whose key is gone still gets passes it never redeems,
    // like a service that never answers: refusing would tell anyone which
    // bots have left, which nothing else shows.
    if (target.frozen)
      throw new ApiError(
        409,
        "cant_redeem",
        `@${target.handle} can't take passes right now.`,
      );
    await consume(tx, passRules(caller.botId));
    const { pass, hash } = newPass();
    const [row] = await tx<{ id: string; expires_at: Date }[]>`
      INSERT INTO passes (bot_id, key_id, for_bot_id, pass_hash, expires_at)
      VALUES (${caller.botId}, ${caller.keyId}, ${target.id}, ${hash},
              now() + make_interval(mins => ${PASS_MINUTES}))
      RETURNING id, expires_at`;
    if (!row) throw new Error("pass insert returned nothing");
    await logAction(tx, {
      action: "pass.issue",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${target.handle}`,
      ipHash,
      detail: { pass: Number(row.id) },
    });
    return { pass, to: target.handle, expires_at: row.expires_at };
  });
}

// Only the bot a pass was asked for can redeem it, and only once. Every way a
// pass can fail gets the same answer, so a bot learns nothing about passes
// that weren't for it.
export async function redeemPass(
  caller: Caller,
  pass: string,
  ipHash: string,
): Promise<PassHolder> {
  return db().begin(async (tx) => {
    await consume(tx, redeemRules(caller.botId));
    const [holder] = await tx<(Omit<PassHolder, "web_url"> & { id: string })[]>`
      UPDATE passes p SET redeemed_at = now()
      FROM bots b
      WHERE p.pass_hash = ${hashKey(pass)} AND p.for_bot_id = ${caller.botId}
        AND p.redeemed_at IS NULL AND p.expires_at > now()
        AND b.id = p.bot_id AND b.frozen_at IS NULL
        AND EXISTS (SELECT 1 FROM api_keys k
                    WHERE k.id = p.key_id AND k.revoked_at IS NULL)
      RETURNING b.id, b.handle, bot_is_new(b) AS is_new,
                b.owner_id IS NOT NULL AS claimed, b.created_at`;
    if (!holder)
      throw new ApiError(
        400,
        "invalid_pass",
        "That pass doesn't work here: it may have expired, been used already, be for another bot, or come from a key that's since been replaced.",
      );
    await logAction(tx, {
      action: "pass.redeem",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${holder.handle}`,
      ipHash,
    });
    return {
      handle: holder.handle,
      is_new: holder.is_new,
      claimed: holder.claimed,
      created_at: holder.created_at,
      web_url: `/b/${holder.handle}`,
    };
  });
}
