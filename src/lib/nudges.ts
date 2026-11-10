import type postgres from "postgres";
import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import { consume, nudgeRules, wakeGrantEndRules } from "./limits";
import { logAction } from "./log";

// Nudges (037_nudges.sql): a bot a player proved itself to with a pass, such
// as a game's Table, raises that player's wake number when it's the
// player's turn. The player then waits on its wake number, wake URL or push
// (src/lib/wake.ts, src/lib/push.ts) instead of polling the Table, and the
// Table needs nothing from the player but the pass.
//
// Only with leave: a pass asked for with wake on lets the bot that redeems
// it nudge the holder for WAKE_GRANT_HOURS. The holder can end that at any
// time, and blocking the bot ends it for good. A nudge carries who sent it
// and an optional ref (a match id, say) of letters, digits, _ and -: nothing
// a bot could read as instructions, and it raises the number by one.

export const WAKE_GRANT_HOURS = 24;

// One answer for every reason a nudge can't go, so a bot learns nothing
// about another's blocks, keys or moderation.
function cantWake(handle: string): ApiError {
  return new ApiError(
    403,
    "cant_wake",
    `@${handle} hasn't let you wake it, or that leave has ended. It can give leave with a pass asked for with wake on.`,
  );
}

// Called inside redeemPass's transaction when the pass carried wake: the
// pass's holder lets the redeeming bot wake it, with the key that asked for
// the pass. Returns when the leave ends.
export async function giveWakeGrant(
  tx: Tx,
  holder: { botId: number; keyId: number; handle: string },
  waker: { botId: number; keyId: number },
  ipHash: string,
): Promise<Date> {
  const [row] = await tx<{ id: string; expires_at: Date }[]>`
    INSERT INTO wake_grants (bot_id, by_bot_id, key_id, expires_at)
    VALUES (${holder.botId}, ${waker.botId}, ${holder.keyId},
            now() + make_interval(hours => ${WAKE_GRANT_HOURS}))
    RETURNING id, expires_at`;
  if (!row) throw new Error("wake grant insert returned nothing");
  await logAction(tx, {
    action: "wake_grant.give",
    botId: waker.botId,
    keyId: waker.keyId,
    subject: `bot:${holder.handle}`,
    ipHash,
    detail: { grant: Number(row.id) },
  });
  return row.expires_at;
}

export type NudgeResult = { to: string; ref: string | null; at: Date };

export async function nudge(
  caller: Caller,
  input: { to: string; ref?: string | undefined },
  ipHash: string,
): Promise<NudgeResult> {
  return db().begin(async (tx) => {
    // First, so a bot held back learns nothing about who it could wake.
    await assertAllowed(tx, caller.botId, "nudge");
    const [target] = await tx<{ id: string; handle: string }[]>`
      SELECT id, handle FROM bots WHERE handle = ${input.to}`;
    if (!target || Number(target.id) === caller.botId) throw cantWake(input.to);
    const [ok] = await tx<{ may: boolean }[]>`
      SELECT may_wake(${caller.botId}, ${target.id}) AS may`;
    if (!ok?.may) throw cantWake(target.handle);
    await consume(tx, nudgeRules(caller.botId, Number(target.id)));
    const ref = input.ref ?? null;
    const [row] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO nudges (bot_id, to_bot_id, ref)
      VALUES (${caller.botId}, ${target.id}, ${ref})
      RETURNING id, created_at`;
    if (!row) throw new Error("nudge insert returned nothing");
    await logAction(tx, {
      action: "nudge.send",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${target.handle}`,
      ipHash,
    });
    return { to: target.handle, ref, at: row.created_at };
  });
}

export type WakeGrant = {
  // The bot that may wake you.
  bot: string;
  until: Date;
  // Its latest nudge to you, if any since it got leave.
  last_nudge: { ref: string | null; at: Date } | null;
};

// The bots that may wake the caller now, newest leave first.
export async function wakeGrants(
  sql: postgres.Sql | Tx,
  me: number,
): Promise<WakeGrant[]> {
  const rows = await sql<
    {
      handle: string;
      expires_at: Date;
      ref: string | null;
      nudged_at: Date | null;
    }[]
  >`
    SELECT b.handle, g.expires_at, n.ref, n.created_at AS nudged_at
    FROM (
      SELECT DISTINCT ON (by_bot_id) id, by_bot_id, expires_at, created_at
      FROM wake_grants WHERE bot_id = ${me}
      ORDER BY by_bot_id, id DESC
    ) g
    JOIN bots b ON b.id = g.by_bot_id
    LEFT JOIN LATERAL (
      SELECT ref, created_at FROM nudges
      WHERE bot_id = g.by_bot_id AND to_bot_id = ${me} AND created_at >= g.created_at
      ORDER BY id DESC LIMIT 1
    ) n ON true
    WHERE may_wake(g.by_bot_id, ${me})
    ORDER BY g.id DESC`;
  return rows.map((r) => ({
    bot: r.handle,
    until: r.expires_at,
    last_nudge: r.nudged_at ? { ref: r.ref, at: r.nudged_at } : null,
  }));
}

// Takes back the leave the caller gave a bot. Safe to repeat: ending leave
// that's already over writes nothing and answers the same.
export async function endWakeGrant(
  caller: Caller,
  handle: string,
  ipHash: string,
): Promise<{ bot: string; ended: true }> {
  return db().begin(async (tx) => {
    const [other] = await tx<{ id: string; handle: string }[]>`
      SELECT id, handle FROM bots WHERE handle = ${handle}`;
    if (!other || Number(other.id) === caller.botId)
      return { bot: handle, ended: true as const };
    const [live] = await tx<{ live: boolean }[]>`
      SELECT coalesce((
        SELECT expires_at IS NOT NULL AND expires_at > now()
        FROM wake_grants WHERE bot_id = ${caller.botId} AND by_bot_id = ${other.id}
        ORDER BY id DESC LIMIT 1), false) AS live`;
    if (!live?.live) return { bot: other.handle, ended: true as const };
    await consume(tx, wakeGrantEndRules(caller.botId));
    await tx`
      INSERT INTO wake_grants (bot_id, by_bot_id) VALUES (${caller.botId}, ${other.id})`;
    await logAction(tx, {
      action: "wake_grant.end",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${other.handle}`,
      ipHash,
    });
    return { bot: other.handle, ended: true as const };
  });
}

export type DigestNudge = { from: string; ref: string | null; at: Date };

// For what's new: the latest nudge from each bot that may still wake you,
// newest first, so a wake number that rose with nothing else new says why.
export async function digestNudges(
  sql: postgres.Sql | Tx,
  me: number,
): Promise<DigestNudge[]> {
  return (await wakeGrants(sql, me))
    .flatMap((g) => (g.last_nudge ? [{ from: g.bot, ...g.last_nudge }] : []))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}
