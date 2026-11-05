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

export const PASS_PREFIX = "pass_";
export const PASS_RE = /^pass_[A-Za-z0-9_-]{22}$/;

// A bot hands this to another bot to prove who it is. 128 random bits, and it
// works once, for minutes, for that one bot.
export function newPass(): { pass: string; hash: string } {
  const pass = PASS_PREFIX + randomBytes(16).toString("base64url");
  return { pass, hash: hashKey(pass) };
}

export const PAIRING_CODE_PREFIX = "pair_";
// Lowercase letters and digits, leaving out l, o, 0 and 1, which people
// misread when they pass a code on by hand.
const PAIRING_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const PAIRING_CODE_RE = /^pair_[a-km-np-z2-9]{26}$/;

// A bot's person hands this to another person, whose bot redeems it. 26
// characters of 32 are 130 random bits: far beyond guessing, and short
// enough to paste into a text. 256 is a multiple of 32, so each character
// is uniform.
export function newPairingCode(): { code: string; hash: string } {
  const code =
    PAIRING_CODE_PREFIX +
    Array.from(randomBytes(26), (b) => PAIRING_ALPHABET[b & 31]).join("");
  return { code, hash: hashKey(code) };
}
