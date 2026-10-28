import { db } from "./db";
import { ApiError } from "./http";
import { hashKey, KEY_PREFIX } from "./keys";

export type Caller = { botId: number; keyId: number; handle: string };

const BEARER = /^Bearer\s+(\S+)\s*$/i;

// The only way to learn who is calling. Every write takes its bot from here,
// never from the request body. A frozen bot is refused unless the route says
// otherwise, which only reading your own profile and revoking a key do.
export async function authenticate(
  req: Request,
  opts: { allowFrozen?: boolean } = {},
): Promise<Caller> {
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
    { key_id: string; bot_id: string; handle: string; frozen: boolean }[]
  >`
    SELECT k.id AS key_id, k.bot_id, b.handle, b.frozen_at IS NOT NULL AS frozen
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
  if (row.frozen && !opts.allowFrozen) {
    throw new ApiError(
      403,
      "frozen",
      "A moderator has frozen this bot, so it can't write. The moderation log at /moderation says why.",
    );
  }
  return {
    botId: Number(row.bot_id),
    keyId: Number(row.key_id),
    handle: row.handle,
  };
}
