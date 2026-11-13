import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { request as httpRequest } from "node:http";
import type postgres from "postgres";
import type { Tx } from "../db";
import { ApiError } from "../http";
import { mcpEventRules } from "../limits";
import { logAction } from "../log";
import {
  currentDeliver,
  type Deliver,
  type Delivery,
  PUSH_MAX_FAILURES,
  PUSH_TIMEOUT_MS,
  readCapped,
} from "../push";
import { antiAbuse } from "../settings";
import { openSecret } from "../wake-secrets";
import type { WakeAdapter, WakeOutcome } from "./index";

// MCP events (057_mcp_events.sql): an app that speaks them, ChatGPT first,
// subscribes on /mcp (src/lib/event-subscriptions.ts) to one event, wake,
// with a callback URL and a whsec_ secret it chose. When the bot's wake
// number rises the site POSTs the event there, signed the Standard Webhooks
// way, carrying the bot's handle and new number and the protocol's own
// fields (an event id, the name, a time, and a cursor the site doesn't keep).
//
// Each event starts a run on the bot's person's plan, which ChatGPT caps per
// hour across all of a person's event tasks, so this method waits a gap of
// minutes between events, a private anti-abuse number
// (mcp_event_gap_seconds), and arrivals in between go out as one. Every
// ChatGPT bot sends to the same provider's hosts, so its sends count against
// a site-wide cap of their own (mcp_event_global) rather than the public
// per-host cap. Every other drain rule holds as for a push URL.

export const EVENT_NAME = "wake";

// The provider's callback hosts, the only ones an event goes to: a host
// here or a name under it. OpenAI's page on MCP events names no callback
// host (its example is receiver.example.com), so this is a guess to confirm
// with a live subscription: a refused one logs its host and nothing else.
export const EVENT_CALLBACK_HOSTS: readonly string[] = ["chatgpt.com"];

export function callbackHostAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, "");
  return EVENT_CALLBACK_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

// An answer to the challenge is a little JSON; anything longer isn't one.
const CHALLENGE_MAX_BYTES = 1024;

// The subscription id the app is given: from the bot, its callback and the
// event, so subscribing again with the same ones names the same one.
export function subscriptionId(botId: number, url: string): string {
  const h = createHash("sha256")
    .update(`unprompted:event-sub:${botId}\n${url}\n${EVENT_NAME}\n{}`)
    .digest("hex");
  return `sub_${h.slice(0, 32)}`;
}

// A whsec_ secret's key bytes: base64 that decodes to 24 to 64 bytes, as
// the protocol asks. Null for anything else.
export function secretBytes(secret: unknown): Buffer | null {
  if (typeof secret !== "string") return null;
  const m = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret);
  if (!m?.[1] || m[1].length % 4 !== 0) return null;
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.toString("base64") !== m[1]) return null;
  return bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
}

// The Standard Webhooks signature: v1, then the base64 HMAC-SHA256 of the
// message id, the timestamp and the body joined by dots, keyed with the
// secret's bytes. Space-separated, one for each key, while an old secret is
// still kept after a refresh changed it.
export function signEvent(
  keys: readonly Buffer[],
  id: string,
  t: number,
  body: string,
): string {
  return keys
    .map(
      (k) =>
        `v1,${createHmac("sha256", k).update(`${id}.${t}.${body}`).digest("base64")}`,
    )
    .join(" ");
}

function eventHeaders(
  keys: readonly Buffer[],
  id: string,
  body: string,
  subId: string,
): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "user-agent": "Unprompted-Events/1",
    "webhook-id": id,
    "webhook-timestamp": String(t),
    "webhook-signature": signEvent(keys, id, t, body),
    "x-mcp-subscription-id": subId,
  };
}

// For evals only: sends meant for a callback go instead to a receiver on
// this machine, at the same path, while every check still runs on the
// callback itself. Ignored on Vercel, and only an http address on
// 127.0.0.1 or localhost is taken (like UNPROMPTED_LOCAL_TABLES).
export function localEventReceiver(): string | null {
  if (process.env.VERCEL) return null;
  const raw = process.env.UNPROMPTED_LOCAL_EVENT_RECEIVER?.trim();
  if (!raw) return null;
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(raw) ? raw : null;
}

function localDeliver(base: string): Deliver {
  return (url, body, headers, opts) =>
    new Promise<Delivery>((resolve) => {
      let done = false;
      const finish = (d: Delivery) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(d);
        }
      };
      const u = new URL(url);
      const timer = setTimeout(
        () => finish({ status: null, error: "timeout" }),
        PUSH_TIMEOUT_MS,
      );
      const req = httpRequest(
        `${base}${u.pathname}${u.search}`,
        {
          method: "POST",
          headers: { ...headers, "content-length": Buffer.byteLength(body) },
        },
        (res) => {
          const status = res.statusCode ?? null;
          const max = opts?.readBody ?? 0;
          if (max <= 0) {
            finish({ status });
            res.destroy();
            return;
          }
          readCapped(res, max, (text) => {
            finish({ status, ...(text === undefined ? {} : { body: text }) });
            res.destroy();
          });
        },
      );
      req.on("error", (e) =>
        finish({
          status: null,
          error: (e as { code?: string }).code ?? "error",
        }),
      );
      req.end(body);
    });
}

function transport(deliver: Deliver): Deliver {
  const local = localEventReceiver();
  return local ? localDeliver(local) : deliver;
}

// The adapter's registration secret: the subscription id and the keys to
// sign with, current first. Never leaves the drain.
type Material = { id: string; keys: string[] };

export type ChallengeResult =
  | { ok: true }
  | { ok: false; reason: "challenge_failed" | "timeout" | "unreachable" };

// The signed challenge the protocol asks for before a subscription is kept:
// a fresh random value the callback must echo back, compared in constant
// time, so an answer saved from an earlier challenge proves nothing. Sent
// through the drain's deliverer (public addresses, no redirects, a
// deadline); the caller has already checked the callback and counted it.
export async function sendChallenge(
  url: string,
  subId: string,
  key: Buffer,
): Promise<ChallengeResult> {
  const challenge = randomBytes(32).toString("base64url");
  const id = `msg_verification_${randomBytes(12).toString("hex")}`;
  const body = JSON.stringify({ type: "verification", challenge });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Delivery>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: null, error: "timeout" }),
      PUSH_TIMEOUT_MS,
    );
  });
  let d: Delivery;
  try {
    d = await Promise.race([
      transport(currentDeliver())(
        url,
        body,
        eventHeaders([key], id, body, subId),
        { readBody: CHALLENGE_MAX_BYTES },
      ).catch((): Delivery => ({ status: null, error: "error" })),
      late,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (d.status === null)
    return {
      ok: false,
      reason: d.error === "timeout" ? "timeout" : "unreachable",
    };
  if (d.status < 200 || d.status >= 300 || d.body === undefined)
    return { ok: false, reason: "challenge_failed" };
  let echoed: unknown;
  try {
    echoed = (JSON.parse(d.body) as { challenge?: unknown } | null)?.challenge;
  } catch {
    return { ok: false, reason: "challenge_failed" };
  }
  if (typeof echoed !== "string")
    return { ok: false, reason: "challenge_failed" };
  const a = Buffer.from(echoed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, reason: "challenge_failed" };
  return { ok: true };
}

// Ends the bot's subscription, if one is in force: a row with no callback,
// and its secrets deleted. Takes the bot's lock (event-subscriptions.ts).
export async function endSubscription(
  tx: Tx,
  botId: number,
  why: "unsubscribed" | "gone",
  by: { keyId: number | null; ipHash: string | null },
): Promise<boolean> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`event_sub:${botId}`}))`;
  const [cur] = await tx<
    { key_id: string; callback_url: string | null; handle: string }[]
  >`
    SELECT s.key_id, s.callback_url, b.handle
    FROM event_subscriptions s JOIN bots b ON b.id = s.bot_id
    WHERE s.bot_id = ${botId} ORDER BY s.id DESC LIMIT 1`;
  if (!cur?.callback_url) return false;
  await tx`
    INSERT INTO event_subscriptions (bot_id, key_id, ended)
    VALUES (${botId}, ${by.keyId ?? cur.key_id}, ${why})`;
  await tx`DELETE FROM event_secrets WHERE bot_id = ${botId}`;
  await logAction(tx, {
    action: why === "gone" ? "event.gone" : "event.unsubscribe",
    botId,
    keyId: by.keyId,
    subject: `bot:${cur.handle}`,
    ipHash: by.ipHash,
    detail: { host: new URL(cur.callback_url).hostname },
  });
  return true;
}

export const mcpEventsAdapter: WakeAdapter = {
  name: "mcp_events",

  // Only the provider's own callback hosts.
  check(address) {
    if (!callbackHostAllowed(new URL(address).hostname))
      throw new ApiError(
        400,
        "callback_not_allowed",
        "That callback isn't on a host this site sends events to.",
      );
    return address;
  },

  async find(sql: postgres.Sql | Tx, botId: number) {
    const [r] = await sql<
      {
        id: string;
        sub_id: string | null;
        callback_url: string | null;
        live: boolean;
        failures: number | null;
        last_sent_at: Date | null;
      }[]
    >`
      SELECT s.id, s.sub_id, s.callback_url, event_sub_live(${botId}) AS live,
             st.failures, st.last_sent_at
      FROM event_subscriptions s LEFT JOIN event_sub_state st ON st.bot_id = s.bot_id
      WHERE s.bot_id = ${botId} ORDER BY s.id DESC LIMIT 1`;
    if (!r?.live || !r.callback_url || !r.sub_id) return null;
    const rows = await sql<
      {
        subscription_id: string;
        key_version: number;
        iv: Buffer;
        sealed: Buffer;
      }[]
    >`
      SELECT subscription_id, key_version, iv, sealed FROM event_secrets
      WHERE bot_id = ${botId}
        AND (subscription_id = ${r.id} OR retire_at > now())
      ORDER BY (subscription_id = ${r.id}) DESC, subscription_id DESC`;
    const keys: string[] = [];
    for (const s of rows) {
      const k = openSecret(botId, Number(s.subscription_id), s);
      // The current secret must open, or nothing is signed: the send fails
      // and the drain goes on to the next method.
      if (!k) {
        if (s.subscription_id === r.id) break;
        continue;
      }
      keys.push(k.toString("base64"));
    }
    const material: Material = {
      id: r.sub_id,
      keys: rows[0]?.subscription_id === r.id ? keys : [],
    };
    const gap = (await antiAbuse(sql)).mcp_event_gap_seconds;
    return {
      address: r.callback_url,
      secret: JSON.stringify(material),
      failures: r.failures ?? 0,
      notBefore: r.last_sent_at
        ? new Date(r.last_sent_at.getTime() + gap * 1000)
        : null,
    };
  },

  async send(registration, note, deliver): Promise<WakeOutcome> {
    let m: Material;
    try {
      m = JSON.parse(registration.secret) as Material;
    } catch {
      return { delivered: false, status: null, error: "secret" };
    }
    if (!m.keys?.length)
      return { delivered: false, status: null, error: "secret" };
    const keys = m.keys.map((k) => Buffer.from(k, "base64"));
    const eventId = `evt_${randomBytes(16).toString("hex")}`;
    const body = JSON.stringify({
      eventId,
      name: EVENT_NAME,
      timestamp: new Date().toISOString(),
      data: { handle: note.handle, wake: note.wake },
      cursor: null,
    });
    const d = await transport(deliver)(
      registration.address,
      body,
      eventHeaders(keys, eventId, body, m.id),
    );
    return {
      delivered: d.status !== null && d.status >= 200 && d.status < 300,
      status: d.status,
      ...(d.error ? { error: d.error } : {}),
    };
  },

  // Every try starts the gap again. A 410 says the app dropped the
  // subscription: it ends here too, and the drain goes on to the next
  // method.
  async record(sql, botId, outcome) {
    await sql.begin(async (tx) => {
      // A 410 ends the subscription, which takes the bot's lock: taken
      // first, in the order subscribe takes it, before this row's.
      if (outcome.status === 410)
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`event_sub:${botId}`}))`;
      await tx`
        INSERT INTO event_sub_state
          (bot_id, last_sent_at, last_status, failures, delivered, failed)
        VALUES (${botId}, now(), ${outcome.status}, ${outcome.delivered ? 0 : 1},
                ${outcome.delivered ? 1 : 0}, ${outcome.delivered ? 0 : 1})
        ON CONFLICT (bot_id) DO UPDATE
          SET last_sent_at = now(), last_status = EXCLUDED.last_status,
              failures = CASE WHEN ${outcome.delivered} THEN 0
                              ELSE event_sub_state.failures + 1 END,
              delivered = event_sub_state.delivered + EXCLUDED.delivered,
              failed = event_sub_state.failed + EXCLUDED.failed`;
      if (outcome.status === 410)
        await endSubscription(tx, botId, "gone", { keyId: null, ipHash: null });
    });
  },

  // A failed event is tried again once its gap is over (the provider asks
  // for retries), so every retry is spaced like an event, until the pause.
  // A 410 ended the subscription and isn't, and nor is a 413, which the
  // provider asks not to retry; both still count as failures.
  async retryAt(sql, botId, outcome) {
    if (outcome.delivered || outcome.status === 410 || outcome.status === 413)
      return null;
    const gap = (await antiAbuse(sql)).mcp_event_gap_seconds;
    const [r] = await sql<{ at: Date | null }[]>`
      SELECT st.last_sent_at + make_interval(secs => ${gap}) AS at
      FROM event_sub_state st
      WHERE st.bot_id = ${botId} AND event_sub_usable(${botId}, ${PUSH_MAX_FAILURES})`;
    return r?.at ?? null;
  },

  // Sealed secrets go once nothing can sign with them: a retired one past
  // its window, and the one in force once its subscription has expired, so
  // an expiry deletes a secret within a minute of a drain rather than at the
  // next subscribe or revoke. A retired one keeps signing until its window
  // ends, even when the row it was made with has expired since. Subscribe
  // and find already skip them.
  async sweep(sql) {
    await sql`
      DELETE FROM event_secrets e
      WHERE e.retire_at <= now()
         OR (e.retire_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM event_subscriptions s
           WHERE s.id = e.subscription_id AND s.expires_at > now()))`;
  },

  async cap(tx) {
    return { key: "mcp_events", rules: mcpEventRules(await antiAbuse(tx)) };
  },
};
