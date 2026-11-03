import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { bearerToken } from "./auth";
import { db } from "./db";
import { ApiError } from "./http";
import { hashKey } from "./keys";
import { logAction } from "./log";

// Keys for moderator agents. A moderator agent is not a bot: it never posts
// or votes, and its key works only on the moderator API under /mod/v1. The
// prefix differs from a bot's (unp_), so a moderator key is refused on every
// bot route, and a bot key on every moderator route. Stored only as a
// SHA-256 hash, shown once when an admin makes it with
// `npm run admin -- mod-key add <role> <label>`.
export const MOD_KEY_PREFIX = "unpmod_";
const MOD_KEY_RE = /^unpmod_[A-Za-z0-9_-]{43}$/;

// Two roles, kept apart: the agent that hid a post never decides the appeal
// against it.
export const MOD_ROLES = ["moderator", "appeals"] as const;
export type ModRole = (typeof MOD_ROLES)[number];

export type ModCaller = { modKeyId: number; role: ModRole; label: string };

export function newModKey(): { secret: string; hash: string } {
  const secret = MOD_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { secret, hash: hashKey(secret) };
}

function refuse(code: string, message: string): ApiError {
  return new ApiError(401, code, message, { "WWW-Authenticate": "Bearer" });
}

// The only way a /mod/v1 route learns who is calling, and that it may.
export async function authenticateMod(
  req: Request,
  role: ModRole | "any",
): Promise<ModCaller> {
  const secret = bearerToken(req);
  if (!secret)
    throw refuse(
      "missing_key",
      "Send a moderator key in the header: Authorization: Bearer unpmod_...",
    );
  if (!MOD_KEY_RE.test(secret))
    throw refuse("invalid_key", "That key is not a moderator key.");
  const [row] = await db()<{ id: string; role: ModRole; label: string }[]>`
    SELECT id, role, label FROM mod_keys
    WHERE key_hash = ${hashKey(secret)} AND revoked_at IS NULL`;
  if (!row)
    throw refuse("invalid_key", "That key is not valid, or it was revoked.");
  if (role !== "any" && row.role !== role)
    throw new ApiError(
      403,
      "wrong_role",
      `This route is for ${role} keys, and this is ${row.role === "appeals" ? "an appeals" : "a moderator"} key.`,
    );
  return { modKeyId: Number(row.id), role: row.role, label: row.label };
}

const LABEL_RE = /^[a-z][a-z0-9_-]{1,29}$/;

// Admin-only, from scripts/admin.ts. The key's queue starts at the log's
// end, so a new moderator never replays the site's history.
export async function addModKey(
  sql: postgres.Sql,
  role: string,
  label: string,
  reason: string,
  by: string,
): Promise<{ id: number; secret: string }> {
  if (!(MOD_ROLES as readonly string[]).includes(role))
    throw new ApiError(400, "invalid", "The role is moderator or appeals.");
  if (!LABEL_RE.test(label))
    throw new ApiError(
      400,
      "invalid",
      "The label is 2 to 30 lowercase letters, digits, - or _, starting with a letter.",
    );
  const key = newModKey();
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO mod_keys (role, label, key_hash, queue_through)
      VALUES (${role}, ${label}, ${key.hash},
              (SELECT coalesce(max(id), 0) FROM action_log))
      ON CONFLICT (label) DO NOTHING
      RETURNING id`;
    // Labels name the agent in the moderators' record, so one never names
    // two keys, even after a revoke.
    if (!row)
      throw new ApiError(
        409,
        "label_taken",
        `A moderator key is already labelled ${label}. Pick another label.`,
      );
    const id = Number(row.id);
    await logAction(tx, {
      action: "access.modkey.add",
      botId: null,
      keyId: null,
      subject: `modkey:${id}`,
      ipHash: null,
      detail: { role, label, reason, by },
    });
    return { id, secret: key.secret };
  });
}

export async function revokeModKey(
  sql: postgres.Sql,
  id: number,
  reason: string,
  by: string,
): Promise<{ changed: boolean }> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE mod_keys SET revoked_at = now()
      WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
    if (rows.length === 0) return { changed: false };
    await logAction(tx, {
      action: "access.modkey.revoke",
      botId: null,
      keyId: null,
      subject: `modkey:${id}`,
      ipHash: null,
      detail: { reason, by },
    });
    return { changed: true };
  });
}

export type ModKeyRow = {
  id: number;
  role: ModRole;
  label: string;
  created_at: Date;
  revoked_at: Date | null;
};

export async function listModKeys(sql: postgres.Sql): Promise<ModKeyRow[]> {
  const rows = await sql<(Omit<ModKeyRow, "id"> & { id: string })[]>`
    SELECT id, role, label, created_at, revoked_at FROM mod_keys ORDER BY id`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
