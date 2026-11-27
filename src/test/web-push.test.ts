import {
  createECDH,
  generateKeyPairSync,
  randomBytes,
  verify,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkPushKeys,
  encryptPush,
  MAX_PLAINTEXT,
  vapidAuthorization,
} from "@/lib/web-push";
import { browser, browserDecrypt } from "./browser-push";

// Web Push written against node:crypto (W1b). The encryption is held to the
// worked example in RFC 8291 section 5, byte for byte, and to a browser's
// side of the exchange written out here; the VAPID token to RFC 8292.

const b = (s: string) => Buffer.from(s, "base64url");

// RFC 8291, section 5.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("encrypting a push for one browser", () => {
  it("matches RFC 8291's worked example byte for byte", () => {
    const body = encryptPush(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: b(RFC.salt), serverPrivateKey: b(RFC.asPrivate) },
    );
    expect(body.toString("base64url")).toBe(RFC.body);
    expect(browserDecrypt(body, b(RFC.uaPrivate), b(RFC.auth)).toString()).toBe(
      RFC.plaintext,
    );
  });

  it("gives a fresh key and salt every time, and the browser reads it", () => {
    const ua = browser();
    const text = Buffer.from(JSON.stringify({ url: "/account/channels/5" }));
    const one = encryptPush(text, ua.keys);
    const two = encryptPush(text, ua.keys);
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(one.subarray(21, 86).equals(two.subarray(21, 86))).toBe(false);
    expect(browserDecrypt(one, ua.priv, ua.auth).equals(text)).toBe(true);
    expect(browserDecrypt(two, ua.priv, ua.auth).equals(text)).toBe(true);
  });

  it("can't be read with another browser's keys", () => {
    const ua = browser();
    const other = browser();
    const body = encryptPush(Buffer.from("hello"), ua.keys);
    expect(() => browserDecrypt(body, other.priv, other.auth)).toThrow();
    expect(() => browserDecrypt(body, ua.priv, other.auth)).toThrow();
  });

  it("refuses a payload that wouldn't fit one record", () => {
    const ua = browser();
    // Header (salt, record size, key length, key), then the record and
    // its tag: the longest payload fills the 4096 bytes push services take.
    const longest = encryptPush(Buffer.alloc(MAX_PLAINTEXT), ua.keys);
    expect(longest.length).toBe(21 + 65 + MAX_PLAINTEXT + 1 + 16);
    expect(longest.length).toBeLessThanOrEqual(4096);
    expect(() => encryptPush(Buffer.alloc(MAX_PLAINTEXT + 1), ua.keys)).toThrow(
      /too long/,
    );
  });
});

describe("checking a browser's subscription keys", () => {
  it("takes a real P-256 point and a 16-byte secret", () => {
    expect(checkPushKeys(browser().keys)).toBe(true);
    expect(checkPushKeys({ p256dh: RFC.uaPublic, auth: RFC.auth })).toBe(true);
  });

  it("refuses anything else", () => {
    const good = browser().keys;
    const notOnCurve = Buffer.alloc(65, 1);
    notOnCurve[0] = 4;
    const compressed = createECDH("prime256v1");
    compressed.generateKeys();
    for (const keys of [
      { ...good, auth: randomBytes(15).toString("base64url") },
      { ...good, auth: randomBytes(17).toString("base64url") },
      { ...good, p256dh: notOnCurve.toString("base64url") },
      {
        ...good,
        p256dh: compressed
          .getPublicKey(null, "compressed")
          .toString("base64url"),
      },
      { ...good, p256dh: "" },
      { p256dh: "not base64 at all!", auth: "" },
    ])
      expect(checkPushKeys(keys), JSON.stringify(keys)).toBe(false);
  });
});

describe("the VAPID token a push carries", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = privateKey.export({ format: "jwk" }) as {
    d: string;
    x: string;
    y: string;
  };
  const pub = Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]).toString(
    "base64url",
  );
  const vapid = {
    publicKey: pub,
    privateKey: jwk.d,
    subject: "https://unprompted.test",
  };

  it("names the push service's origin, expires within a day, and verifies", () => {
    const now = 1_800_000_000;
    const header = vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc:def",
      vapid,
      now,
    );
    const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(m).not.toBeNull();
    const [token, k] = [m?.[1] ?? "", m?.[2] ?? ""];
    expect(k).toBe(pub);
    const [h, c, s] = token.split(".");
    expect(JSON.parse(b(h ?? "").toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const claims = JSON.parse(b(c ?? "").toString());
    expect(claims).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now + 12 * 3600,
      sub: "https://unprompted.test",
    });
    expect(claims.exp - now).toBeLessThanOrEqual(24 * 3600);
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      b(s ?? ""),
    );
    expect(ok).toBe(true);
    // Another key doesn't verify it.
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${c}`),
        { key: other.publicKey, dsaEncoding: "ieee-p1363" },
        b(s ?? ""),
      ),
    ).toBe(false);
  });

  it("refuses a public key that isn't an uncompressed P-256 point", () => {
    expect(() =>
      vapidAuthorization(
        "https://web.push.apple.com/x",
        { ...vapid, publicKey: Buffer.alloc(33, 2).toString("base64url") },
        0,
      ),
    ).toThrow(/VAPID/);
  });
});
