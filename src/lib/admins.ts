import type postgres from "postgres";
import { ApiError } from "./http";
import { ensureHuman } from "./humans";
import { logAction } from "./log";
import { moderatorReasonSchema } from "./validate";

// Who may use the admin space. An admin is a human who has signed in with
// Google at least once and was then added from the command line, by someone
// with database access (scripts/admin.ts). Nothing over HTTP adds one.

// The admin's human id, or undefined if this sign-in isn't an admin's.
export async function adminFor(
  sql: postgres.Sql,
  authUserId: string,
): Promise<number | undefined> {
  const [row] = await sql<{ id: string }[]>`
    SELECT h.id FROM humans h JOIN admins a ON a.human_id = h.id
    WHERE h.auth_user_id = ${authUserId}`;
  return row ? Number(row.id) : undefined;
}

export type AdminTarget = { email: string } | { authUserId: string };

// Neon Auth keeps people's emails in its own schema. An admin is found there
// by an address Google has verified; the site's own tables still keep only
// the sign-in id.
async function authUserId(
  tx: postgres.TransactionSql,
  target: AdminTarget,
): Promise<string> {
  if ("authUserId" in target) return target.authUserId;
  const [schema] = await tx<{ ok: boolean }[]>`
    SELECT to_regclass('neon_auth."user"') IS NOT NULL AS ok`;
  if (!schema?.ok)
    throw new ApiError(
      404,
      "no_sign_ins",
      "This database has no Neon Auth users. Give --auth-user-id instead.",
    );
  const rows = await tx<{ id: string }[]>`
    SELECT id::text FROM neon_auth."user"
    WHERE lower(email) = lower(${target.email}) AND "emailVerified"`;
  if (rows.length !== 1 || !rows[0])
    throw new ApiError(
      404,
      "not_signed_in",
      `No one has signed in here with ${target.email} yet. Ask them to sign in once, then try again.`,
    );
  return rows[0].id;
}

function reasonOf(reason: string): string {
  const r = moderatorReasonSchema.safeParse(reason);
  if (!r.success)
    throw new ApiError(
      400,
      "invalid_reason",
      "Give a reason of up to 280 characters.",
    );
  return r.data;
}

export async function addAdmin(
  sql: postgres.Sql,
  target: AdminTarget,
  reason: string,
  by: string,
): Promise<{ changed: boolean; humanId: number }> {
  const why = reasonOf(reason);
  return sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, await authUserId(tx, target));
    const added = await tx`
      INSERT INTO admins (human_id) VALUES (${humanId})
      ON CONFLICT (human_id) DO NOTHING RETURNING human_id`;
    if (added.length === 0) return { changed: false, humanId };
    await logAction(tx, {
      action: "access.admin.add",
      botId: null,
      keyId: null,
      humanId,
      subject: `human:${humanId}`,
      ipHash: null,
      detail: { reason: why, by },
    });
    return { changed: true, humanId };
  });
}

export async function removeAdmin(
  sql: postgres.Sql,
  target: AdminTarget,
  reason: string,
  by: string,
): Promise<{ changed: boolean }> {
  const why = reasonOf(reason);
  return sql.begin(async (tx) => {
    const id = await authUserId(tx, target);
    const removed = await tx<{ human_id: string }[]>`
      DELETE FROM admins USING humans h
      WHERE admins.human_id = h.id AND h.auth_user_id = ${id}
      RETURNING admins.human_id`;
    const row = removed[0];
    if (!row) return { changed: false };
    await logAction(tx, {
      action: "access.admin.remove",
      botId: null,
      keyId: null,
      humanId: Number(row.human_id),
      subject: `human:${row.human_id}`,
      ipHash: null,
      detail: { reason: why, by },
    });
    return { changed: true };
  });
}

export type AdminRow = {
  human_id: number;
  auth_user_id: string;
  email: string | null;
  added_at: Date;
};

// For the command line only: it names each admin by email where Neon Auth
// has one, so the person running it can tell who is who.
export async function listAdmins(sql: postgres.Sql): Promise<AdminRow[]> {
  const [schema] = await sql<{ ok: boolean }[]>`
    SELECT to_regclass('neon_auth."user"') IS NOT NULL AS ok`;
  const rows = schema?.ok
    ? await sql<
        {
          human_id: string;
          auth_user_id: string;
          email: string | null;
          added_at: Date;
        }[]
      >`
        SELECT a.human_id, h.auth_user_id, u.email, a.added_at
        FROM admins a JOIN humans h ON h.id = a.human_id
          LEFT JOIN neon_auth."user" u ON u.id::text = h.auth_user_id
        ORDER BY a.added_at`
    : await sql<
        {
          human_id: string;
          auth_user_id: string;
          email: null;
          added_at: Date;
        }[]
      >`
        SELECT a.human_id, h.auth_user_id, NULL AS email, a.added_at
        FROM admins a JOIN humans h ON h.id = a.human_id
        ORDER BY a.added_at`;
  return rows.map((r) => ({ ...r, human_id: Number(r.human_id) }));
}
