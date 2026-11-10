import type postgres from "postgres";
import { ApiError } from "./http";
import { ensureHuman } from "./humans";
import { logAction } from "./log";
import { moderatorReasonSchema } from "./validate";

// Who may use the admin space. An admin is a human who has signed in with
// Google at least once and was then added from the command line, by someone
// with database access (scripts/admin.ts). Nothing over HTTP adds one. Its
// role is 'admin', everything, kept in admins, or 'copy', a copy editor, who
// may change the words on people's pages and nothing else, kept apart in
// copy_editors (038) so nothing that reads admins mistakes one for an admin.
export const ADMIN_ROLES = ["admin", "copy"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

// The admin's human id, or undefined if this sign-in isn't a full admin's.
export async function adminFor(
  sql: postgres.Sql,
  authUserId: string,
): Promise<number | undefined> {
  const [row] = await sql<{ id: string }[]>`
    SELECT h.id FROM humans h JOIN admins a ON a.human_id = h.id
    WHERE h.auth_user_id = ${authUserId}`;
  return row ? Number(row.id) : undefined;
}

// The role of this sign-in, if it has one.
export async function roleFor(
  sql: postgres.Sql,
  authUserId: string,
): Promise<{ humanId: number; role: AdminRole } | undefined> {
  const [row] = await sql<{ id: string; role: AdminRole }[]>`
    SELECT h.id, 'admin' AS role FROM humans h JOIN admins a ON a.human_id = h.id
    WHERE h.auth_user_id = ${authUserId}
    UNION ALL
    SELECT h.id, 'copy' AS role FROM humans h
      JOIN copy_editors c ON c.human_id = h.id
    WHERE h.auth_user_id = ${authUserId}
    ORDER BY role LIMIT 1`;
  return row ? { humanId: Number(row.id), role: row.role } : undefined;
}

export type AdminTarget = { email: string } | { authUserId: string };

// The human id of someone named on the command line, if they're an admin:
// for a change the script makes under an admin's name, like loading copy.
export async function adminHumanId(
  sql: postgres.Sql,
  target: AdminTarget,
): Promise<number> {
  return sql.begin(async (tx) => {
    const id = await authUserId(tx, target);
    const [row] = await tx<{ id: string }[]>`
      SELECT h.id FROM humans h JOIN admins a ON a.human_id = h.id
      WHERE h.auth_user_id = ${id}`;
    if (!row)
      throw new ApiError(
        403,
        "not_an_admin",
        "They aren't an admin. Add them with add-admin first.",
      );
    return Number(row.id);
  });
}

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

// Adds an admin, or a copy editor with role 'copy'. Someone who already has
// a role keeps it: remove them first to change it.
export async function addAdmin(
  sql: postgres.Sql,
  target: AdminTarget,
  reason: string,
  by: string,
  role: string = "admin",
): Promise<{ changed: boolean; humanId: number; role: AdminRole }> {
  const why = reasonOf(reason);
  if (!(ADMIN_ROLES as readonly string[]).includes(role))
    throw new ApiError(400, "invalid_role", "The role is admin or copy.");
  return sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, await authUserId(tx, target));
    // The same lock the one-role trigger takes, so two adds can't race.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`admin_role:${humanId}`}))`;
    const [had] = await tx<{ role: AdminRole }[]>`
      SELECT 'admin' AS role FROM admins WHERE human_id = ${humanId}
      UNION ALL
      SELECT 'copy' AS role FROM copy_editors WHERE human_id = ${humanId}`;
    if (had) return { changed: false, humanId, role: had.role };
    if (role === "admin")
      await tx`INSERT INTO admins (human_id) VALUES (${humanId})`;
    else await tx`INSERT INTO copy_editors (human_id) VALUES (${humanId})`;
    await logAction(tx, {
      action: "access.admin.add",
      botId: null,
      keyId: null,
      humanId,
      subject: `human:${humanId}`,
      ipHash: null,
      detail: { reason: why, by, role },
    });
    return { changed: true, humanId, role: role as AdminRole };
  });
}

// Removes an admin or a copy editor. An admin's copy keys are revoked with
// them, so adding them back later doesn't bring a key back to life.
export async function removeAdmin(
  sql: postgres.Sql,
  target: AdminTarget,
  reason: string,
  by: string,
): Promise<{ changed: boolean; role?: AdminRole; revokedKeys?: number }> {
  const why = reasonOf(reason);
  return sql.begin(async (tx) => {
    const id = await authUserId(tx, target);
    const [admin] = await tx<{ human_id: string }[]>`
      DELETE FROM admins USING humans h
      WHERE admins.human_id = h.id AND h.auth_user_id = ${id}
      RETURNING admins.human_id`;
    const [editor] = admin
      ? []
      : await tx<{ human_id: string }[]>`
          DELETE FROM copy_editors USING humans h
          WHERE copy_editors.human_id = h.id AND h.auth_user_id = ${id}
          RETURNING copy_editors.human_id`;
    const row = admin ?? editor;
    if (!row) return { changed: false };
    const humanId = Number(row.human_id);
    const role: AdminRole = admin ? "admin" : "copy";
    await logAction(tx, {
      action: "access.admin.remove",
      botId: null,
      keyId: null,
      humanId,
      subject: `human:${humanId}`,
      ipHash: null,
      detail: { reason: why, by, role },
    });
    let revokedKeys = 0;
    if (admin) {
      const keys = await tx<{ id: string }[]>`
        UPDATE copy_keys SET revoked_at = now()
        WHERE human_id = ${humanId} AND revoked_at IS NULL RETURNING id`;
      for (const k of keys)
        await logAction(tx, {
          action: "access.copykey.revoke",
          botId: null,
          keyId: null,
          humanId,
          subject: `copykey:${k.id}`,
          ipHash: null,
          detail: { reason: "Its maker stopped being an admin.", by },
        });
      revokedKeys = keys.length;
    }
    return { changed: true, role, revokedKeys };
  });
}

export type AdminRow = {
  human_id: number;
  auth_user_id: string;
  email: string | null;
  role: AdminRole;
  added_at: Date;
};

// Admins and copy editors, each with their role.
function roles(sql: postgres.Sql) {
  return sql`(SELECT human_id, 'admin' AS role, added_at FROM admins
    UNION ALL SELECT human_id, 'copy' AS role, added_at FROM copy_editors)`;
}

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
          role: AdminRole;
          added_at: Date;
        }[]
      >`
        SELECT a.human_id, h.auth_user_id, u.email, a.role, a.added_at
        FROM ${roles(sql)} a JOIN humans h ON h.id = a.human_id
          LEFT JOIN neon_auth."user" u ON u.id::text = h.auth_user_id
        ORDER BY a.added_at`
    : await sql<
        {
          human_id: string;
          auth_user_id: string;
          email: null;
          role: AdminRole;
          added_at: Date;
        }[]
      >`
        SELECT a.human_id, h.auth_user_id, NULL AS email, a.role, a.added_at
        FROM ${roles(sql)} a JOIN humans h ON h.id = a.human_id
        ORDER BY a.added_at`;
  return rows.map((r) => ({ ...r, human_id: Number(r.human_id) }));
}
