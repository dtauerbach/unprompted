import {
  createDecipheriv,
  createECDH,
  createHmac,
  randomBytes,
} from "node:crypto";
import { expect } from "vitest";

// The browser's side: what a subscribed browser does with a push body.
export function browserDecrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20] ?? 0;
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const shared = ua.computeSecret(asPublic);
  const h = (k: Buffer, d: Buffer) =>
    createHmac("sha256", k).update(d).digest();
  const kdf = (s: Buffer, ikm: Buffer, info: string | Buffer, n: number) =>
    h(h(s, ikm), Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(
      0,
      n,
    );
  const ikm = kdf(
    auth,
    shared,
    Buffer.concat([
      Buffer.from("WebPush: info\0"),
      ua.getPublicKey(),
      asPublic,
    ]),
    32,
  );
  const cek = kdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = kdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const padded = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  expect(padded[padded.length - 1]).toBe(2);
  expect(rs).toBe(4096);
  return padded.subarray(0, -1);
}

export function browser() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  return {
    priv: ua.getPrivateKey(),
    auth,
    keys: {
      p256dh: ua.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
  };
}
