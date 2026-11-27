import { createECDH, createHash } from "node:crypto";
import type postgres from "postgres";
import { copyInForce } from "./copy";
import type { Tx } from "./db";
import { ApiError } from "./http";
import { ensureHuman } from "./humans";
import { consume, personPushRules } from "./limits";
import { logAction } from "./log";
import { type DeliverBytes, httpsDeliverBytes } from "./push";
import { isReadOnly } from "./settings";
import { openSecret, sealSecret, wakeSecretsAvailable } from "./wake-secrets";
import {
  checkPushKeys,
  encryptPush,
  type PushKeys,
  type Vapid,
  vapidAuthorization,
} from "./web-push";

// Push to a person (W1b, 093_person_push.sql): with the site on their home
// screen, a person turns push on for a phone or browser, and when a bot
// writes in a channel they started the site sends that device a notice
// that opens the channel. The notice holds the copy store's words and the
// channel's address, never a word a bot wrote: a lock screen is no place
// for untrusted text, and the message is the person's to read in the app.

// Push services browsers use. A subscription's address must be at one of
// them, so the site never sends to an address a person (or a page acting
// as them) made up.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

// Devices one person can have on at once.
export const PERSON_PUSH_DEVICES = 5;
// A burst of messages in one channel makes one notice: after one goes,
// nothing more for that channel until this long has passed.
export const PERSON_PUSH_GAP_SECONDS = 600;
const MAX_ENDPOINT = 1000;

export type PushSubscriptionInput = { endpoint: string; keys: PushKeys };

export function checkEndpoint(endpoint: string): URL | null {
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT)
    return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username) return null;
  if (url.password) return null;
  if (!PUSH_HOSTS.some((h) => h.test(url.hostname))) return null;
  return url;
}

// The site's VAPID key pair and contact, from the environment, or null when
// any is missing or doesn't parse: then push can't be turned on.
export function vapidConfig(
  env: NodeJS.ProcessEnv = process.env,
): Vapid | null {
  const publicKey = env.WEB_PUSH_PUBLIC_KEY?.trim();
  const privateKey = env.WEB_PUSH_PRIVATE_KEY?.trim();
  const subject = env.WEB_PUSH_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  const vapid = { publicKey, privateKey, subject };
  try {
    // The private key must be the public key's own: a push service checks
    // the signature against the key the browser was given.
    const d = Buffer.from(privateKey, "base64url");
    if (d.length !== 32) return null;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    if (ecdh.getPublicKey("base64url") !== publicKey) return null;
    vapidAuthorization("https://fcm.googleapis.com/x", vapid, 0);
  } catch {
    return null;
  }
  return vapid;
}

export function personPushAvailable(): boolean {
  return vapidConfig() !== null && wakeSecretsAvailable();
}

const deviceOf = (endpoint: string) =>
  createHash("sha256").update(endpoint).digest("hex");

function refuseUnless(ok: boolean) {
  if (!ok)
    throw new ApiError(
      400,
      "invalid_subscription",
      "That isn't a push subscription this site can send to.",
    );
}

async function liveDevices(tx: Tx | postgres.Sql, humanId: number) {
  return tx<{ id: string; device: string; host: string }[]>`
    SELECT p.id, p.device, p.host FROM person_push_subs p
     WHERE p.human_id = ${humanId} AND person_push_live(p.id)
     ORDER BY p.id`;
}

// Turns push on for the browser that subscribed. Saving the same device
// again (a new key from the browser) replaces its row.
export async function subscribePerson(
  sql: postgres.Sql,
  authUserId: string,
  input: PushSubscriptionInput,
  ipHash: string | null,
): Promise<{ devices: number }> {
  if (isReadOnly())
    throw new ApiError(503, "read_only", "The site is read-only right now.");
  const url = checkEndpoint(input?.endpoint);
  refuseUnless(url !== null && checkPushKeys(input.keys ?? ({} as PushKeys)));
  if (!personPushAvailable())
    throw new ApiError(
      503,
      "unavailable",
      "Push can't be turned on for this site right now.",
    );
  const endpoint = (url as URL).href;
  const device = deviceOf(endpoint);
  const secret = Buffer.from(
    JSON.stringify({
      endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
    }),
  );
  return sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, authUserId);
    // One person's changes queue behind each other, so two at once can't
    // pass the device cap.
    await tx`SELECT pg_advisory_xact_lock(hashtext('person-push'), ${humanId}::int)`;
    await consume(tx, personPushRules(humanId));
    const live = await liveDevices(tx, humanId);
    if (
      !live.some((d) => d.device === device) &&
      live.length >= PERSON_PUSH_DEVICES
    )
      throw new ApiError(
        409,
        "too_many_devices",
        `Push is on for ${PERSON_PUSH_DEVICES} devices already: turn it off on one first.`,
      );
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO person_push_subs (human_id, device, host)
      VALUES (${humanId}, ${device}, ${(url as URL).hostname})
      RETURNING id`;
    if (!row) throw new Error("no subscription row");
    const sealed = sealSecret(humanId, Number(row.id), secret, "person-push");
    await tx`
      INSERT INTO person_push_secrets (sub_id, human_id, device, key_version, iv, sealed)
      VALUES (${row.id}, ${humanId}, ${device}, ${sealed.key_version},
              ${sealed.iv}, ${sealed.sealed})`;
    await logAction(tx, {
      action: "human.push.subscribe",
      botId: null,
      keyId: null,
      humanId,
      subject: `human:${humanId}`,
      ipHash,
      detail: { host: (url as URL).hostname },
    });
    const n = live.some((d) => d.device === device)
      ? live.length
      : live.length + 1;
    return { devices: n };
  });
}

// Turns push off for one browser. Not counted, and works under the kill
// switch, since it only stops something; with nothing on, nothing changes.
export async function unsubscribePerson(
  sql: postgres.Sql,
  authUserId: string,
  endpoint: string,
  ipHash: string | null,
): Promise<{ devices: number }> {
  const url = checkEndpoint(endpoint);
  if (!url) return { devices: 0 };
  const device = deviceOf(url.href);
  return sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, authUserId);
    await tx`SELECT pg_advisory_xact_lock(hashtext('person-push'), ${humanId}::int)`;
    const live = await liveDevices(tx, humanId);
    if (!live.some((d) => d.device === device)) return { devices: live.length };
    await endDevice(tx, humanId, device, url.hostname, "removed");
    await logAction(tx, {
      action: "human.push.unsubscribe",
      botId: null,
      keyId: null,
      humanId,
      subject: `human:${humanId}`,
      ipHash,
      detail: { host: url.hostname },
    });
    return { devices: live.length - 1 };
  });
}

async function endDevice(
  tx: Tx,
  humanId: number,
  device: string,
  host: string,
  why: "removed" | "gone",
) {
  await tx`
    INSERT INTO person_push_subs (human_id, device, host, ended)
    VALUES (${humanId}, ${device}, ${host}, ${why})`;
}

// How many devices a person has push on for, for their account page.
export async function personPushDevices(
  sql: postgres.Sql,
  humanId: number,
): Promise<number> {
  return (await liveDevices(sql, humanId)).length;
}

type Claimed = { human_id: string; channel_id: string; sent: boolean };

// Sends what's waiting: one notice per channel a bot wrote in, to each of
// its person's devices, unless one went for that channel in the last
// PERSON_PUSH_GAP_SECONDS (then the waiting mark is dropped: the person
// already has a notice that opens the channel). A hidden channel sends
// nothing. Claims skip rows another drain holds.
export async function drainPersonPushes(
  sql: postgres.Sql,
  deps: {
    deliver?: DeliverBytes;
    now?: () => number;
    vapid?: Vapid | null;
    limit?: number;
    // When to stop sending: channels not reached by then wait again for
    // the next round, so a round never outlives the request it runs after.
    until?: number;
  } = {},
): Promise<{
  sent: number;
  dropped: number;
  failed: number;
  deferred?: number;
}> {
  const out: {
    sent: number;
    dropped: number;
    failed: number;
    deferred?: number;
  } = { sent: 0, dropped: 0, failed: 0 };
  if (isReadOnly()) return out;
  const vapid = deps.vapid === undefined ? vapidConfig() : deps.vapid;
  if (!vapid) return out;
  const deliver = deps.deliver ?? httpsDeliverBytes;
  const now = deps.now ?? Date.now;
  if (deps.until !== undefined && now() >= deps.until) return out;
  const claimed = await sql.begin(async (tx) => {
    const rows = await tx<Claimed[]>`
      SELECT s.human_id, s.channel_id,
             (s.last_sent_at IS NOT NULL AND s.last_sent_at >
                now() - make_interval(secs => ${PERSON_PUSH_GAP_SECONDS})) AS sent
        FROM person_push_state s
       WHERE s.pending_since IS NOT NULL
       ORDER BY s.pending_since
       LIMIT ${deps.limit ?? 20}
       FOR UPDATE SKIP LOCKED`;
    for (const r of rows)
      await tx`
        UPDATE person_push_state
           SET pending_since = NULL,
               last_sent_at = CASE WHEN ${r.sent} THEN last_sent_at ELSE now() END
         WHERE human_id = ${r.human_id} AND channel_id = ${r.channel_id}`;
    return rows;
  });
  if (claimed.length === 0) return out;
  const copy = await copyInForce(sql);
  for (const [i, c] of claimed.entries()) {
    if (deps.until !== undefined && now() >= deps.until) {
      for (const r of claimed.slice(i).filter((r) => !r.sent))
        await sql`
          UPDATE person_push_state
             SET pending_since = coalesce(pending_since, now()), last_sent_at = NULL
           WHERE human_id = ${r.human_id} AND channel_id = ${r.channel_id}`;
      out.deferred = claimed.length - i;
      break;
    }
    if (c.sent) {
      out.dropped++;
      continue;
    }
    // Only while the person could open what the notice points at: a group
    // a moderator hasn't hidden, with one of their bots in it now and not
    // frozen (src/lib/peek.ts), so a notice never leads to a refusal.
    const [visible] = await sql<{ ok: boolean }[]>`
      SELECT private_channel_is_visible(${c.channel_id}) AND EXISTS (
        SELECT 1 FROM channel_roster(${c.channel_id}) r
          JOIN bots b ON b.id = r.bot_id
         WHERE b.owner_id = ${c.human_id} AND b.frozen_at IS NULL) AS ok`;
    if (!visible?.ok) {
      out.dropped++;
      continue;
    }
    const payload = Buffer.from(
      JSON.stringify({
        title: copy["account.push.notice_title"],
        body: copy["account.push.notice_body"],
        url: `/account/channels/${c.channel_id}`,
      }),
    );
    const subs = await sql<
      {
        id: string;
        device: string;
        host: string;
        key_version: number;
        iv: Buffer;
        sealed: Buffer;
      }[]
    >`
      SELECT p.id, p.device, p.host, x.key_version, x.iv, x.sealed
        FROM person_push_subs p JOIN person_push_secrets x ON x.sub_id = p.id
       WHERE p.human_id = ${c.human_id} AND person_push_live(p.id)
       ORDER BY p.id`;
    const humanId = Number(c.human_id);
    for (const s of subs) {
      const opened = openSecret(humanId, Number(s.id), s, "person-push");
      const parsed = opened ? parseSecret(opened) : null;
      if (!parsed) {
        out.failed++;
        continue;
      }
      const body = encryptPush(payload, parsed.keys);
      const d = await deliver(
        parsed.endpoint,
        body,
        {
          authorization: vapidAuthorization(
            parsed.endpoint,
            vapid,
            Math.floor(now() / 1000),
          ),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: "86400",
          urgency: "normal",
        },
        {},
      );
      const ok = d.status !== null && d.status >= 200 && d.status < 300;
      const gone = d.status === 404 || d.status === 410;
      if (ok) out.sent++;
      else out.failed++;
      // A push service that says the subscription is gone ends it; any
      // other failure is tried again with the next notice, which the gap
      // already spaces out.
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('person-push'), ${humanId}::int)`;
        const [still] = await tx<{ live: boolean }[]>`
          SELECT person_push_live(${s.id}) AS live`;
        if (!still?.live) return;
        if (gone) await endDevice(tx, humanId, s.device, s.host, "gone");
        if (gone || ok)
          await logAction(tx, {
            action: gone ? "person_push.ended" : "person_push.sent",
            botId: null,
            keyId: null,
            humanId,
            subject: `human:${humanId}`,
            ipHash: null,
            detail: gone
              ? { host: s.host, why: "gone" }
              : { host: s.host, channel: Number(c.channel_id) },
          });
      });
    }
  }
  return out;
}

function parseSecret(raw: Buffer): { endpoint: string; keys: PushKeys } | null {
  try {
    const o = JSON.parse(raw.toString("utf8")) as {
      endpoint?: unknown;
      p256dh?: unknown;
      auth?: unknown;
    };
    if (
      typeof o.endpoint !== "string" ||
      typeof o.p256dh !== "string" ||
      typeof o.auth !== "string" ||
      !checkEndpoint(o.endpoint)
    )
      return null;
    return { endpoint: o.endpoint, keys: { p256dh: o.p256dh, auth: o.auth } };
  } catch {
    return null;
  }
}
