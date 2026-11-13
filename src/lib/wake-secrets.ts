import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// A secret a wake method must read back to use, such as the signing secret
// an app chose when it subscribed to MCP events (057_mcp_events.sql). Kept
// encrypted with AES-256-GCM under the server's WAKE_SECRET_KEY, a key of
// its own: not IP_HASH_SECRET, whose rotation already changes every push
// secret. Each sealed secret is bound to its bot and its row, so one row's
// ciphertext can't be moved to another's. Opened only in the drain, just
// before a send, and when a subscription is refreshed; never shown back or
// logged.

// The version written today. A new key gets a new version, and rows sealed
// under the old one are re-sealed or let lapse.
export const WAKE_SECRET_KEY_VERSION = 1;

// The key, or null when none is set in production: methods that keep a
// secret are then off, and say so, rather than seal under a key anyone can
// read in the repo.
function key(): Buffer | null {
  const raw = process.env.WAKE_SECRET_KEY?.trim();
  if (raw) {
    const bytes = /^[0-9a-f]{64}$/i.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64");
    if (bytes.length === 32) return bytes;
    console.warn(
      JSON.stringify({ event: "wake_secret_key", problem: "not 32 bytes" }),
    );
    return null;
  }
  if (process.env.NODE_ENV === "production") return null;
  return createHash("sha256")
    .update("unprompted:dev-only:wake-secrets")
    .digest();
}

export function wakeSecretsAvailable(): boolean {
  return key() !== null;
}

const aad = (botId: number, rowId: number, version: number) =>
  Buffer.from(`unprompted:wake-secret:${botId}:${rowId}:v${version}`);

export type Sealed = { key_version: number; iv: Buffer; sealed: Buffer };

export function sealSecret(
  botId: number,
  rowId: number,
  secret: Buffer,
): Sealed {
  const k = key();
  if (!k) throw new Error("WAKE_SECRET_KEY is not set");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(aad(botId, rowId, WAKE_SECRET_KEY_VERSION));
  const body = Buffer.concat([c.update(secret), c.final(), c.getAuthTag()]);
  return { key_version: WAKE_SECRET_KEY_VERSION, iv, sealed: body };
}

// The secret, or null when it can't be opened (another key, another row,
// or a changed byte): a send then fails, and falls through.
export function openSecret(
  botId: number,
  rowId: number,
  s: Sealed,
): Buffer | null {
  const k = key();
  if (!k || s.key_version !== WAKE_SECRET_KEY_VERSION) return null;
  if (s.sealed.length < 17) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", k, s.iv);
    d.setAAD(aad(botId, rowId, s.key_version));
    d.setAuthTag(s.sealed.subarray(s.sealed.length - 16));
    return Buffer.concat([
      d.update(s.sealed.subarray(0, s.sealed.length - 16)),
      d.final(),
    ]);
  } catch {
    return null;
  }
}
