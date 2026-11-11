import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { checkReason } from "./admin";
import type { CopyEditor } from "./copy";
import { ApiError } from "./http";
import { hashKey } from "./keys";
import { adminRules, consume } from "./limits";
import { logAction } from "./log";

// Copy keys: how an app, such as an admin's own assistant, changes the words
// on people's pages without an admin's Google sign-in. An admin makes one at
// /admin/copy and sees it once; it's kept only as a SHA-256 hash. It works
// only while it isn't revoked and its maker is still an admin (removing the
// maker revokes it), acts as a copy editor (never on the admin-only pieces),
// and its saves are under its maker's name, with an hourly limit of its own.
// The copy connector (src/lib/copy-mcp.ts) is the one place it's taken. It
// travels in the connector's address, so a host's request logs can hold it.
export const COPY_KEY_PREFIX = "unpcopy_";
const COPY_KEY_RE = /^unpcopy_[A-Za-z0-9_-]{43}$/;
const LABEL_RE = /^[a-z][a-z0-9_-]{1,29}$/;

export type CopyKeyEditor = CopyEditor & { keyId: number; label: string };

export function newCopyKey(): { secret: string; hash: string } {
  const secret = COPY_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { secret, hash: hashKey(secret) };
}

export async function copyEditorForKey(
  sql: postgres.Sql,
  secret: string | undefined,
): Promise<CopyKeyEditor> {
  if (!secret)
    throw new ApiError(
      401,
      "missing_key",
      "Use the address an admin made for you at /admin/copy, or send its key as Authorization: Bearer.",
    );
  if (!COPY_KEY_RE.test(secret))
    throw new ApiError(401, "invalid_key", "That isn't a copy key.");
  const [row] = await sql<{ id: string; label: string; human_id: string }[]>`
    SELECT k.id, k.label, k.human_id FROM copy_keys k
    JOIN admins a ON a.human_id = k.human_id
    WHERE k.key_hash = ${hashKey(secret)} AND k.revoked_at IS NULL`;
  if (!row)
    throw new ApiError(
      401,
      "invalid_key",
      "That copy key isn't valid, or it was revoked.",
    );
  return {
    humanId: Number(row.human_id),
    role: "copy",
    keyId: Number(row.id),
    label: row.label,
  };
}

// For a full admin, from /admin/copy. The action checks the admin; the
// change counts against their hourly limit and is logged with their id.
export async function makeCopyKey(
  sql: postgres.Sql,
  opts: { humanId: number; label: string; reason: string },
): Promise<{ id: number; secret: string }> {
  if (!LABEL_RE.test(opts.label))
    throw new ApiError(
      400,
      "invalid",
      "The label is 2 to 30 lowercase letters, digits, - or _, starting with a letter.",
    );
  const why = checkReason(opts.reason);
  const key = newCopyKey();
  return sql.begin(async (tx) => {
    await consume(tx, adminRules(opts.humanId));
    // Still an admin, held until commit, so a key made while its maker is
    // being removed is either refused here or revoked by the removal. Kept
    // after consume, so a flood of refused makes can't hold off a removal.
    const [still] = await tx`
      SELECT 1 FROM admins WHERE human_id = ${opts.humanId} FOR SHARE`;
    if (!still)
      throw new ApiError(403, "not_an_admin", "Only admins can do that.");
    // A label names the key in every version it saves, so one never names
    // two keys, even after a revoke.
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO copy_keys (label, key_hash, human_id)
      VALUES (${opts.label}, ${key.hash}, ${opts.humanId})
      ON CONFLICT (label) DO NOTHING RETURNING id`;
    if (!row)
      throw new ApiError(
        409,
        "label_taken",
        `A copy key is already labelled ${opts.label}. Pick another label.`,
      );
    const id = Number(row.id);
    await logAction(tx, {
      action: "access.copykey.add",
      botId: null,
      keyId: null,
      humanId: opts.humanId,
      subject: `copykey:${id}`,
      ipHash: null,
      detail: { label: opts.label, reason: why },
    });
    return { id, secret: key.secret };
  });
}

// Any full admin may revoke any copy key. Taking access away never counts
// against a limit, and works in read-only mode.
export async function revokeCopyKey(
  sql: postgres.Sql,
  opts: { id: number; humanId: number; reason: string },
): Promise<{ changed: boolean }> {
  const why = checkReason(opts.reason);
  return sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE copy_keys SET revoked_at = now()
      WHERE id = ${opts.id} AND revoked_at IS NULL RETURNING id`;
    if (rows.length === 0) return { changed: false };
    await logAction(tx, {
      action: "access.copykey.revoke",
      botId: null,
      keyId: null,
      humanId: opts.humanId,
      subject: `copykey:${opts.id}`,
      ipHash: null,
      detail: { reason: why },
    });
    return { changed: true };
  });
}

export type CopyKeyRow = {
  id: number;
  label: string;
  human_id: number;
  created_at: Date;
  revoked_at: Date | null;
  // Whether it works now: not revoked, and its maker still an admin.
  live: boolean;
  // When it last saved words, if it ever did.
  last_saved_at: Date | null;
};

export async function listCopyKeys(sql: postgres.Sql): Promise<CopyKeyRow[]> {
  const rows = await sql<
    {
      id: string;
      label: string;
      human_id: string;
      created_at: Date;
      revoked_at: Date | null;
      live: boolean;
      last_saved_at: Date | null;
    }[]
  >`
    SELECT k.id, k.label, k.human_id, k.created_at, k.revoked_at,
      k.revoked_at IS NULL AND EXISTS (SELECT 1 FROM admins a
        WHERE a.human_id = k.human_id) AS live,
      (SELECT max(v.created_at) FROM copy_versions v
        WHERE v.copy_key_id = k.id) AS last_saved_at
    FROM copy_keys k ORDER BY k.id DESC`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    human_id: Number(r.human_id),
  }));
}
