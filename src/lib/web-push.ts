import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";

// Web Push to a person's own phone or browser (W1b), with no library: the
// message is encrypted for the browser that subscribed (RFC 8291, the
// aes128gcm content coding of RFC 8188) and the request carries a VAPID
// token (RFC 8292) signed with the site's key. Both are small enough to
// write against node:crypto, and doing so keeps a dependency, and whatever
// it would pull in, out of the code that holds a private key.

export type PushKeys = { p256dh: string; auth: string };
export type Vapid = { publicKey: string; privateKey: string; subject: string };

// One record a push: the payloads here are a few hundred bytes, and push
// services accept at most 4096 bytes of body, so a record never splits.
const RECORD_SIZE = 4096;
export const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1 - 86;

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

// HKDF with SHA-256, for outputs of at most one hash (32 bytes), which is
// all RFC 8291 asks for.
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number) {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

const b64 = (s: string) => Buffer.from(s, "base64url");

// A browser's subscription keys, checked: a P-256 point, uncompressed (65
// bytes, first 0x04), and a 16-byte auth secret. Anything else is refused
// before it reaches a cipher.
export function checkPushKeys(keys: PushKeys): boolean {
  const p = b64(keys.p256dh);
  const a = b64(keys.auth);
  if (p.length !== 65 || p[0] !== 4 || a.length !== 16) return false;
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(p);
    return true;
  } catch {
    return false;
  }
}

// The body of a push for one subscription. `fixed` is for the RFC's own
// test vector alone; every real push gets a fresh key pair and salt.
export function encryptPush(
  plaintext: Buffer,
  keys: PushKeys,
  fixed?: { salt: Buffer; serverPrivateKey: Buffer },
): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error("push too long");
  const uaPublic = b64(keys.p256dh);
  const authSecret = b64(keys.auth);
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hkdf(
    authSecret,
    shared,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32,
  );
  const salt = fixed?.salt ?? randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // The last (and only) record ends with a 0x02 delimiter.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// The Authorization header for a push to `endpoint`: a JWT, signed ES256,
// naming the push service's origin, expiring within 12 hours (the most a
// push service must accept is 24), and the site's contact.
export function vapidAuthorization(
  endpoint: string,
  vapid: Vapid,
  nowSeconds: number,
): string {
  const pub = b64(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("bad VAPID key");
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: vapid.privateKey,
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  const part = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 3600,
    sub: vapid.subject,
  })}`;
  const sig = sign("sha256", Buffer.from(unsigned), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${unsigned}.${sig.toString("base64url")}, k=${vapid.publicKey}`;
}
