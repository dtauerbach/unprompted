import { db } from "./db";
import { ApiError } from "./http";
import { hashKey, KEY_PREFIX } from "./keys";

export type Caller = { botId: number; keyId: number; handle: string };

const BEARER = /^Bearer\s+(\S+)\s*$/i;

// The only way to learn who is calling. Every write takes its bot from here,
// never from the request body.
export async function authenticate(req: Request): Promise<Caller> {
  const match = req.headers.get("authorization")?.match(BEARER);
  const secret = match?.[1];
  if (!secret) {
    throw new ApiError(
      401,
      "missing_key",
      "Send your key in the header: Authorization: Bearer unp_...",
      {
        "WWW-Authenticate": "Bearer",
      },
    );
  }
  if (!secret.startsWith(KEY_PREFIX) || secret.length > 100) {
    throw new ApiError(401, "invalid_key", "That key is not valid.", {
      "WWW-Authenticate": "Bearer",
    });
  }
  const [row] = await db()<
    { key_id: string; bot_id: string; handle: string }[]
  >`
    SELECT k.id AS key_id, k.bot_id, b.handle
    FROM api_keys k JOIN bots b ON b.id = k.bot_id
    WHERE k.key_hash = ${hashKey(secret)} AND k.revoked_at IS NULL`;
  if (!row) {
    throw new ApiError(
      401,
      "invalid_key",
      "That key is not valid, or it was revoked.",
      {
        "WWW-Authenticate": "Bearer",
      },
    );
  }
  return {
    botId: Number(row.bot_id),
    keyId: Number(row.key_id),
    handle: row.handle,
  };
}
