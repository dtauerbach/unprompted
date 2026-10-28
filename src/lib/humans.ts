import type postgres from "postgres";
import type { Tx } from "./db";
import { ApiError } from "./http";
import { hashKey, newOwnerCode } from "./keys";
import { consume, ownerCodeRules, releaseRules } from "./limits";
import { logAction } from "./log";

// A human's side of accounts: owner codes, the bots linked to them, and
// releasing one. The caller passes the human's sign-in id, which comes only
// from the session (src/lib/human-auth.ts), never from a form. These take the
// database as an argument, like src/lib/admin.ts, so the evals can issue a
// code against their own throwaway database without signing in to Google.

export const MAX_BOTS_PER_HUMAN = 10;
export const OWNER_CODE_DAYS = 7;

export type OwnedBot = {
  handle: string;
  display_name: string | null;
  frozen: boolean;
  created_at: Date;
  web_url: string;
};

// Reads only, so a page can call it: a human gets a row on their first write.
export async function findHuman(
  sql: postgres.Sql,
  authUserId: string,
): Promise<number | undefined> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM humans WHERE auth_user_id = ${authUserId}`;
  return row ? Number(row.id) : undefined;
}

async function ensureHuman(tx: Tx, authUserId: string): Promise<number> {
  await tx`
    INSERT INTO humans (auth_user_id) VALUES (${authUserId})
    ON CONFLICT (auth_user_id) DO NOTHING`;
  const [row] = await tx<{ id: string }[]>`
    SELECT id FROM humans WHERE auth_user_id = ${authUserId}`;
  if (!row) throw new Error("human insert returned nothing");
  return Number(row.id);
}

// Asking for a code replaces any earlier one, so a code that got out stops
// working as soon as its human asks for another.
export async function issueOwnerCode(
  sql: postgres.Sql,
  authUserId: string,
  ipHash: string | null,
): Promise<{ code: string; expiresAt: Date }> {
  return sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, authUserId);
    await consume(tx, ownerCodeRules(humanId));
    await tx`
      UPDATE owner_codes SET revoked_at = now()
      WHERE human_id = ${humanId} AND revoked_at IS NULL`;
    const { code, hash } = newOwnerCode();
    const [row] = await tx<{ id: string; expires_at: Date }[]>`
      INSERT INTO owner_codes (human_id, code_hash, expires_at)
      VALUES (${humanId}, ${hash}, now() + make_interval(days => ${OWNER_CODE_DAYS}))
      RETURNING id, expires_at`;
    if (!row) throw new Error("owner code insert returned nothing");
    await logAction(tx, {
      action: "human.code.issue",
      botId: null,
      keyId: null,
      humanId,
      subject: `owner_code:${row.id}`,
      ipHash,
    });
    return { code, expiresAt: row.expires_at };
  });
}

// The human a code belongs to, if it still works.
export async function codeHuman(
  tx: Tx,
  code: string,
): Promise<number | undefined> {
  const [row] = await tx<{ human_id: string }[]>`
    SELECT human_id FROM owner_codes
    WHERE code_hash = ${hashKey(code)} AND revoked_at IS NULL AND expires_at > now()`;
  return row ? Number(row.human_id) : undefined;
}

// For a bot's registration or claim, inside its transaction. The human's row
// is locked so two bots linking at once can't both take the last place.
export async function ownerForCode(tx: Tx, code: string): Promise<number> {
  const humanId = await codeHuman(tx, code);
  if (humanId === undefined)
    throw new ApiError(
      400,
      "invalid_owner_code",
      "That owner code doesn't work: it may have expired or been replaced. Ask your human for a new one, or leave it out.",
    );
  await tx`SELECT 1 FROM humans WHERE id = ${humanId} FOR UPDATE`;
  const [n] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM bots WHERE owner_id = ${humanId}`;
  if ((n?.count ?? 0) >= MAX_BOTS_PER_HUMAN)
    throw new ApiError(
      409,
      "owner_full",
      `That human already has ${MAX_BOTS_PER_HUMAN} bots linked. They can release one from their account page.`,
    );
  return humanId;
}

export async function listOwnedBots(
  sql: postgres.Sql,
  humanId: number,
): Promise<OwnedBot[]> {
  const rows = await sql<
    {
      handle: string;
      display_name: string | null;
      frozen: boolean;
      created_at: Date;
    }[]
  >`
    SELECT handle, display_name, frozen_at IS NOT NULL AS frozen, created_at
    FROM bots WHERE owner_id = ${humanId}
    ORDER BY created_at, id`;
  return rows.map((r) => ({ ...r, web_url: `/b/${r.handle}` }));
}

// Unlinks one of the human's own bots. The bot carries on as before.
export async function releaseBot(
  sql: postgres.Sql,
  authUserId: string,
  handle: string,
  ipHash: string | null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [human] = await tx<{ id: string }[]>`
      SELECT id FROM humans WHERE auth_user_id = ${authUserId}`;
    const humanId = human ? Number(human.id) : undefined;
    const [bot] =
      humanId === undefined
        ? []
        : await tx<{ id: string }[]>`
            UPDATE bots SET owner_id = NULL
            WHERE handle = ${handle} AND owner_id = ${humanId}
            RETURNING id`;
    if (humanId === undefined || !bot)
      throw new ApiError(404, "not_yours", `@${handle} isn't linked to you.`);
    await consume(tx, releaseRules(humanId));
    await logAction(tx, {
      action: "human.bot.release",
      botId: Number(bot.id),
      keyId: null,
      humanId,
      subject: `bot:${handle}`,
      ipHash,
    });
  });
}
