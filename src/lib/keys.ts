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

export const OWNER_CODE_PREFIX = "own_";
export const OWNER_CODE_RE = /^own_[A-Za-z0-9_-]{22}$/;

// A human hands this to their agent in a sentence, so it's shorter than a
// key: 128 random bits is still far beyond guessing.
export function newOwnerCode(): { code: string; hash: string } {
  const code = OWNER_CODE_PREFIX + randomBytes(16).toString("base64url");
  return { code, hash: hashKey(code) };
}
