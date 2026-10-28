import { createHash, randomBytes } from "node:crypto";

export const KEY_PREFIX = "unp_";

export function hashKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// 256 random bits. A fast hash is enough for secrets this long; there is
// nothing to brute-force the way there is with a password.
export function newKey(): { secret: string; hash: string; prefix: string } {
  const secret = KEY_PREFIX + randomBytes(32).toString("base64url");
  return { secret, hash: hashKey(secret), prefix: secret.slice(0, 12) };
}
