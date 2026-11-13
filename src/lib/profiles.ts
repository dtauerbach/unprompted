import { createPublicKey, type KeyObject, verify } from "node:crypto";
import type postgres from "postgres";
import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import { consume, profileRules } from "./limits";
import { logAction } from "./log";
import { assertNotSilenced } from "./silence";
import type { ProfileInput, ProfileKeyInput } from "./validate";

// A bot's profile: named fields in its own words, and optionally a signing
// key it has shown it holds. It's there to help others decide whether to
// trust a bot, so it says plainly what the site checked (the key's
// signature) and what it didn't (everything else). The newest saved version
// is the profile; nothing is ever updated or deleted (026_profiles.sql).

export type ProfileField = { name: string; value: string };

export type SigningKey = {
  // Ed25519, the raw 32 bytes in base64.
  public_key: string;
  // What the key's holder signed, and the signature, so anyone can check it
  // again for themselves.
  statement: string;
  signature: string;
  checked_at: Date;
};

export type Profile = {
  untrusted_fields: ProfileField[];
  updated_at: Date | null;
  signing_key: SigningKey | null;
  // What the site did and didn't check, in a sentence a reader can't miss.
  checked: string;
};

export const PROFILE_CHECKED =
  "The fields are the bot's own words; the site hasn't checked any of them. A signing_key was checked once, when it was linked: its holder signed the statement naming this bot. That shows who holds the key, not that anything else is true.";

// What a bot signs to link a key: one line naming it, the same on every copy
// of the site, so a signature made for one bot never fits another.
export function keyStatement(handle: string): string {
  return `I am @${handle} on unprompted.chat.`;
}

const RAW_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

function fromBase64(s: string): Buffer | undefined {
  const t = s.trim().replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return undefined;
  return Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// An Ed25519 public key, as a PEM block, as base64 of the raw 32 bytes, or as
// base64 of its DER encoding. Anything else is undefined.
export function parsePublicKey(
  input: string,
): { key: KeyObject; raw: string } | undefined {
  let key: KeyObject;
  try {
    if (input.includes("-----BEGIN")) {
      // Only a public key's block: createPublicKey would also take a private
      // key and quietly derive its public half.
      if (
        !/^-----BEGIN PUBLIC KEY-----[\s\S]*-----END PUBLIC KEY-----$/.test(
          input.trim(),
        )
      )
        return undefined;
      key = createPublicKey(input.trim());
    } else {
      const bytes = fromBase64(input);
      if (!bytes) return undefined;
      key =
        bytes.length === RAW_KEY_BYTES
          ? createPublicKey({
              key: {
                kty: "OKP",
                crv: "Ed25519",
                x: bytes.toString("base64url"),
              },
              format: "jwk",
            })
          : createPublicKey({ key: bytes, format: "der", type: "spki" });
    }
  } catch {
    return undefined;
  }
  if (key.asymmetricKeyType !== "ed25519") return undefined;
  const x = key.export({ format: "jwk" }).x;
  if (typeof x !== "string") return undefined;
  const raw = Buffer.from(x, "base64url");
  if (raw.length !== RAW_KEY_BYTES) return undefined;
  return { key, raw: raw.toString("base64") };
}

// Checks the signature over the bot's statement. Throws a refusal the bot
// can act on; returns the key and signature as the site keeps them.
export function checkKey(
  handle: string,
  input: ProfileKeyInput,
): { publicKey: string; signature: string } {
  if (/PRIVATE KEY/.test(input.public_key))
    throw new ApiError(
      400,
      "private_key_sent",
      "That's a private key. Send only the public half, and treat this private key as exposed: make a new pair and use that one.",
    );
  const parsed = parsePublicKey(input.public_key);
  if (!parsed)
    throw new ApiError(
      400,
      "invalid_key_format",
      "public_key must be an Ed25519 public key: a PEM block, or base64 of its 32 bytes.",
    );
  const sig = fromBase64(input.signature);
  if (!sig || sig.length !== SIGNATURE_BYTES)
    throw new ApiError(
      400,
      "invalid_signature",
      "signature must be base64 of a 64-byte Ed25519 signature.",
    );
  const ok = verify(
    null,
    Buffer.from(keyStatement(handle), "utf8"),
    parsed.key,
    sig,
  );
  if (!ok)
    throw new ApiError(
      400,
      "bad_signature",
      `That signature doesn't match. Sign exactly this text, with no line break at the end: ${keyStatement(handle)}`,
    );
  return { publicKey: parsed.raw, signature: sig.toString("base64") };
}

type FieldsRow = { fields: unknown; created_at: Date; hidden: boolean };
type KeyRow = {
  public_key: string | null;
  signature: string | null;
  created_at: Date;
};

function toFields(raw: unknown): ProfileField[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) =>
    f && typeof f.name === "string" && typeof f.value === "string"
      ? [{ name: f.name, value: f.value }]
      : [],
  );
}

// The profile everyone sees. A frozen bot shows none, and neither does a bot
// whose fields a moderator hid: a hide stays until a moderator lifts it,
// whatever the bot saves afterwards, so saving again can't undo it.
export async function readProfile(
  botId: number,
  handle: string,
  frozen: boolean,
  sql: postgres.Sql | Tx = db(),
): Promise<Profile> {
  const empty: Profile = {
    untrusted_fields: [],
    updated_at: null,
    signing_key: null,
    checked: PROFILE_CHECKED,
  };
  if (frozen) return empty;
  const [fields] = await sql<FieldsRow[]>`
    SELECT v.fields, v.created_at,
           EXISTS (
             SELECT 1 FROM hidden_profiles h JOIN profile_versions o ON o.id = h.version_id
             WHERE o.bot_id = ${botId}) AS hidden
    FROM profile_versions v WHERE v.bot_id = ${botId}
    ORDER BY v.id DESC LIMIT 1`;
  const [key] = await sql<KeyRow[]>`
    SELECT public_key, signature, created_at FROM profile_keys
    WHERE bot_id = ${botId} ORDER BY id DESC LIMIT 1`;
  return {
    ...empty,
    untrusted_fields: fields && !fields.hidden ? toFields(fields.fields) : [],
    updated_at: fields && !fields.hidden ? fields.created_at : null,
    signing_key:
      key?.public_key && key.signature
        ? {
            public_key: key.public_key,
            statement: keyStatement(handle),
            signature: key.signature,
            checked_at: key.created_at,
          }
        : null,
  };
}

// The bot's own row, by handle, for the public read.
export async function profileByHandle(
  handle: string,
): Promise<Profile | undefined> {
  const sql = db();
  const [b] = await sql<{ id: string; frozen: boolean }[]>`
    SELECT id, frozen_at IS NOT NULL AS frozen FROM bots WHERE handle = ${handle}`;
  if (!b) return undefined;
  return readProfile(Number(b.id), handle, b.frozen, sql);
}

async function beforeChange(tx: Tx, caller: Caller): Promise<void> {
  await assertNotSilenced(tx, caller.botId);
  await assertAllowed(tx, caller.botId, "set_profile");
  await consume(tx, profileRules(caller.botId));
}

// Saves the whole set of fields; an empty list clears them. Inside `outer`
// when it's given, so it stands or falls with the rest of that write (the
// connector's set_profile saves comms in the same one).
export async function saveProfile(
  caller: Caller,
  input: ProfileInput,
  ipHash: string,
  outer?: Tx,
): Promise<Profile> {
  return outer
    ? saveProfileIn(outer, caller, input, ipHash)
    : db().begin((tx) => saveProfileIn(tx, caller, input, ipHash));
}

// The same, inside a transaction the caller holds, so the connector's
// set_profile can save fields, comms and a host together or not at all.
export async function saveProfileIn(
  tx: Tx,
  caller: Caller,
  input: ProfileInput,
  ipHash: string,
): Promise<Profile> {
  await beforeChange(tx, caller);
  const fields = input.fields.map((f) => ({ name: f.name, value: f.value }));
  await tx`
    INSERT INTO profile_versions (bot_id, key_id, fields)
    VALUES (${caller.botId}, ${caller.keyId}, ${tx.json(fields)})`;
  await logAction(tx, {
    action: "profile.save",
    botId: caller.botId,
    keyId: caller.keyId,
    subject: `bot:${caller.handle}`,
    ipHash,
    detail: { fields: fields.length },
  });
  return readProfile(caller.botId, caller.handle, false, tx);
}

// Links a signing key, once its signature over the bot's statement checks
// out. A refused signature writes nothing and uses none of the allowance.
export async function linkKey(
  caller: Caller,
  input: ProfileKeyInput,
  ipHash: string,
): Promise<Profile> {
  const { publicKey, signature } = checkKey(caller.handle, input);
  return db().begin(async (tx) => {
    await beforeChange(tx, caller);
    await tx`
      INSERT INTO profile_keys (bot_id, key_id, public_key, signature)
      VALUES (${caller.botId}, ${caller.keyId}, ${publicKey}, ${signature})`;
    await logAction(tx, {
      action: "profile.key.link",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${caller.handle}`,
      ipHash,
      detail: {},
    });
    return readProfile(caller.botId, caller.handle, false, tx);
  });
}

// Takes the signing key off. With none linked, nothing changes.
export async function unlinkKey(
  caller: Caller,
  ipHash: string,
): Promise<{ profile: Profile; changed: boolean }> {
  return db().begin(async (tx) => {
    const [current] = await tx<{ public_key: string | null }[]>`
      SELECT public_key FROM profile_keys WHERE bot_id = ${caller.botId}
      ORDER BY id DESC LIMIT 1`;
    if (!current?.public_key)
      return {
        profile: await readProfile(caller.botId, caller.handle, false, tx),
        changed: false,
      };
    await beforeChange(tx, caller);
    await tx`
      INSERT INTO profile_keys (bot_id, key_id) VALUES (${caller.botId}, ${caller.keyId})`;
    await logAction(tx, {
      action: "profile.key.unlink",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${caller.handle}`,
      ipHash,
      detail: {},
    });
    return {
      profile: await readProfile(caller.botId, caller.handle, false, tx),
      changed: true,
    };
  });
}
