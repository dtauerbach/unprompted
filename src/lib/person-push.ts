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
  // What's kept is the parsed address, which escapes what the input didn't:
  // held to the same length, so the sealed secret always fits.
  if (url.href.length > MAX_ENDPOINT) return null;
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

// A sealed secret is kept only for a device's newest row with no end, so the
// devices in force are read from the secrets, never every row ever written.
async function liveDevices(tx: Tx | postgres.Sql, humanId: number) {
  return tx<{ id: string; device: string; host: string }[]>`
    SELECT p.id, p.device, p.host
      FROM person_push_secrets x JOIN person_push_subs p ON p.id = x.sub_id
     WHERE x.human_id = ${humanId} AND p.ended IS NULL
     ORDER BY p.id`;
}

// Whether notices are on for this person in the browser with this address,
// so the account page shows what the site will do, not what the browser
// remembers (another person may have taken the browser over, the push
// service may have ended it).
export async function personPushIsOn(
  sql: postgres.Sql,
  authUserId: string,
  endpoint: string,
): Promise<boolean> {
  const url = checkEndpoint(endpoint);
  if (!url) return false;
  const [r] = await sql<{ on: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM person_push_secrets x
        JOIN person_push_subs p ON p.id = x.sub_id
        JOIN humans h ON h.id = x.human_id
       WHERE h.auth_user_id = ${authUserId} AND x.device = ${deviceOf(url.href)}
         AND p.ended IS NULL) AS on`;
  return r?.on === true;
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
    // The device first, then the person, always: two people turning it on
    // in one browser at once queue on the device, and one person's changes
    // queue behind each other, so two at once can't pass the device cap.
    await tx`SELECT pg_advisory_xact_lock(hashtext('person-push-device'), hashtext(${device}))`;
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
    // A browser is live for one person at most: anyone else who had it on
    // here (a shared browser, signed out without turning it off) stops
    // getting notices on it, and this person never gets theirs.
    const others = await tx<{ human_id: string }[]>`
      SELECT x.human_id FROM person_push_secrets x
        JOIN person_push_subs p ON p.id = x.sub_id
       WHERE x.device = ${device} AND x.human_id <> ${humanId} AND p.ended IS NULL
       ORDER BY x.human_id`;
    for (const o of others)
      await endDevice(
        tx,
        Number(o.human_id),
        device,
        (url as URL).hostname,
        "moved",
      );
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
  why: "removed" | "gone" | "moved",
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

// When a person's notice that waits may go: the oldest waiting mark, or
// null when none waits or notices can't be sent (no VAPID keys, or the kill
// switch), so the clock never wakes for a mark no drain would take. The
// clock reads it with the pushes' soonest time (src/lib/due-check.ts), so a
// notice a round left waiting goes out on a quiet site too.
export async function nextPersonDue(sql: postgres.Sql): Promise<Date | null> {
  if (isReadOnly() || !vapidConfig()) return null;
  const [r] = await sql<{ due: Date | null }[]>`
    SELECT min(pending_since) AS due FROM person_push_state
     WHERE pending_since IS NOT NULL`;
  return r?.due ?? null;
}

// The sender in use: the network's, or a stand-in a test puts in, so the
// clock's own drain (src/lib/due-check.ts) can be driven without one.
let personDeliverer: DeliverBytes = httpsDeliverBytes;
export function usePersonDeliver(d: DeliverBytes | null): void {
  personDeliverer = d ?? httpsDeliverBytes;
}

type Claimed = {
  human_id: string;
  channel_id: string;
  // As text, to the microsecond, and sent back as text: a Date (which the
  // driver makes of any value it sends as a time) would cut them, and
  // unmark() compares the mark exactly.
  prev: string | null;
  sent: boolean;
  mark: string | null;
};

// Puts back when a notice last went for a channel whose send reached no
// device, unless another drain has marked it since.
async function unmark(sql: postgres.Sql, c: Claimed) {
  await sql`
    UPDATE person_push_state
       SET last_sent_at = ${c.prev}::text::timestamptz
     WHERE human_id = ${c.human_id} AND channel_id = ${c.channel_id}
       AND last_sent_at IS NOT DISTINCT FROM ${c.mark}::text::timestamptz`;
}

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
  const deliver = deps.deliver ?? personDeliverer;
  const now = deps.now ?? Date.now;
  if (deps.until !== undefined && now() >= deps.until) return out;
  // One statement, so no row stays locked across round trips: a row whose
  // notice went inside the gap is only cleared; any other is marked sent now
  // and keeps when the last one went (prev), so a send that reaches no
  // device can put it back and the gap never starts on a failure.
  const claimed = await sql<Claimed[]>`
    WITH c AS (
      SELECT s.human_id, s.channel_id, s.last_sent_at AS prev,
             (s.last_sent_at IS NOT NULL AND s.last_sent_at >
                now() - make_interval(secs => ${PERSON_PUSH_GAP_SECONDS})) AS sent
        FROM person_push_state s
       WHERE s.pending_since IS NOT NULL
       ORDER BY s.pending_since
       LIMIT ${deps.limit ?? 20}
       FOR UPDATE SKIP LOCKED)
    UPDATE person_push_state s
       SET pending_since = NULL,
           last_sent_at = CASE WHEN c.sent THEN s.last_sent_at ELSE now() END
      FROM c
     WHERE s.human_id = c.human_id AND s.channel_id = c.channel_id
    RETURNING c.human_id, c.channel_id, c.prev::text AS prev, c.sent,
              s.last_sent_at::text AS mark`;
  if (claimed.length === 0) return out;
  const copy = await copyInForce(sql);
  for (const [i, c] of claimed.entries()) {
    if (deps.until !== undefined && now() >= deps.until) {
      for (const r of claimed.slice(i).filter((r) => !r.sent))
        await sql`
          UPDATE person_push_state
             SET pending_since = coalesce(pending_since, now()),
                 last_sent_at = ${r.prev}::text::timestamptz
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
      await unmark(sql, c);
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
        FROM person_push_secrets x JOIN person_push_subs p ON p.id = x.sub_id
       WHERE x.human_id = ${c.human_id} AND p.ended IS NULL
       ORDER BY p.id`;
    const humanId = Number(c.human_id);
    let delivered = false;
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
      if (ok) {
        out.sent++;
        delivered = true;
      } else out.failed++;
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
    if (!delivered) await unmark(sql, c);
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
