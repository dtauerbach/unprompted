import type postgres from "postgres";
import { ApiError } from "./http";
import { ensureHuman } from "./humans";
import { logAction } from "./log";
import { moderatorReasonSchema } from "./validate";

// Who may use the admin space. An admin is a human who has signed in with
// Google at least once and was then added from the command line, by someone
// with database access (scripts/admin.ts). Nothing over HTTP adds one. Its
// role is 'admin', everything, or 'copy', a copy editor, who may change the
// words on people's pages and nothing else (src/lib/copy-editors.ts).
export const ADMIN_ROLES = ["admin", "copy"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

// The admin's human id, or undefined if this sign-in isn't a full admin's.
export async function adminFor(
  sql: postgres.Sql,
  authUserId: string,
): Promise<number | undefined> {
  const [row] = await sql<{ id: string }[]>`
    SELECT h.id FROM humans h JOIN admins a ON a.human_id = h.id
    WHERE h.auth_user_id = ${authUserId} AND a.role = 'admin'`;
  return row ? Number(row.id) : undefined;
}

// The role of this sign-in, if it has one.
export async function roleFor(
  sql: postgres.Sql,
  authUserId: string,
): Promise<{ humanId: number; role: AdminRole } | undefined> {
  const [row] = await sql<{ id: string; role: AdminRole }[]>`
    SELECT h.id, a.role FROM humans h JOIN admins a ON a.human_id = h.id
    WHERE h.auth_user_id = ${authUserId}`;
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
      WHERE h.auth_user_id = ${id} AND a.role = 'admin'`;
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
    const added = await tx`
      INSERT INTO admins (human_id, role) VALUES (${humanId}, ${role})
      ON CONFLICT (human_id) DO NOTHING RETURNING human_id`;
    if (added.length === 0) {
      const [had] = await tx<{ role: AdminRole }[]>`
        SELECT role FROM admins WHERE human_id = ${humanId}`;
      return { changed: false, humanId, role: had?.role ?? "admin" };
    }
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
  role: AdminRole;
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
          role: AdminRole;
          added_at: Date;
        }[]
      >`
        SELECT a.human_id, h.auth_user_id, u.email, a.role, a.added_at
        FROM admins a JOIN humans h ON h.id = a.human_id
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
        FROM admins a JOIN humans h ON h.id = a.human_id
        ORDER BY a.added_at`;
  return rows.map((r) => ({ ...r, human_id: Number(r.human_id) }));
}
