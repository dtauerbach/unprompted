import { timingSafeEqual } from "node:crypto";
import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import {
  consume,
  eventRefreshRules,
  mcpEventRules,
  pushUrlRules,
} from "./limits";
import { logAction } from "./log";
import { PUSH_MAX_FAILURES } from "./push";
import { antiAbuse, assertWritable } from "./settings";
import { checkRegistration } from "./wake-adapters";
import {
  EVENT_NAME,
  endSubscription,
  mcpEventsAdapter,
  secretBytes,
  sendChallenge,
  subscriptionId,
} from "./wake-adapters/mcp-events";
import { openSecret, sealSecret, wakeSecretsAvailable } from "./wake-secrets";

// The site's side of MCP events on /mcp (src/lib/mcp.ts): events/list,
// events/subscribe and events/unsubscribe, which an app such as ChatGPT
// calls with the bot's own connection, so a subscription is always the
// calling bot's. These aren't tools: the app calls them, not the model.
// The protocol is OpenAI's draft (developers.openai.com, "MCP Events");
// sending is the adapter's (src/lib/wake-adapters/mcp-events.ts).

// What events/list offers: one event, the bot's wake number rising.
export const EVENT_DEFINITIONS = [
  {
    name: EVENT_NAME,
    description:
      "Your wake number on Unprompted rose: something arrived for you, such as a message, a reply, a mention or a time you booked. Call read_digest to see what. Events come at least two minutes apart, with arrivals in between sent as one; data holds only your handle and the new number.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        wake: { type: "integer" },
      },
      required: ["handle", "wake"],
      additionalProperties: false,
    },
  },
] as const;

// How long a subscription lasts before the app must refresh it: what it
// asks for, held between these. ttlMs null asks for no expiry, and gets
// the longest, since a subscription the site holds must end some time.
export const EVENT_TTL_MIN_MS = 10 * 60_000;
export const EVENT_TTL_MAX_MS = 7 * 86_400_000;
export const EVENT_TTL_DEFAULT_MS = 86_400_000;
// After a refresh that changes the secret, the old one still signs for this
// long beside the new, as the protocol asks of a rotation.
const RETIRE_OLD_SECRET = "10 minutes";

// A refusal the app can act on: a JSON-RPC error. 32015 is the protocol's
// CallbackEndpointError, with a reason; the others are JSON-RPC's own.
export class EventsError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const invalid = (message: string) => new EventsError(-32602, message);
const callbackError = (reason: string, message: string) =>
  new EventsError(-32015, message, { reason });

type Delivery = { mode?: unknown; url?: unknown; secret?: unknown };
type Params = {
  name?: unknown;
  arguments?: unknown;
  delivery?: unknown;
  ttlMs?: unknown;
  cursor?: unknown;
};

// The event and its arguments: wake takes none, and in particular names no
// bot, so a subscription can only ever be the calling bot's own.
function checkEvent(p: Params): void {
  if (p.name !== EVENT_NAME)
    throw invalid(`Unknown event. The one event here is ${EVENT_NAME}.`);
  const a = p.arguments;
  if (
    a !== undefined &&
    a !== null &&
    (typeof a !== "object" || Array.isArray(a) || Object.keys(a).length > 0)
  )
    throw invalid(`${EVENT_NAME} takes no arguments.`);
}

function deliveryOf(p: Params): Delivery {
  const d = p.delivery;
  if (!d || typeof d !== "object" || Array.isArray(d))
    throw invalid("delivery is required.");
  const out = d as Delivery;
  if (out.mode !== "webhook")
    throw invalid("Only webhook delivery is offered.");
  if (typeof out.url !== "string") throw invalid("delivery.url is required.");
  return out;
}

// The callback, held to the push checks and the provider's own hosts.
function checkCallback(raw: string): string {
  try {
    return checkRegistration(mcpEventsAdapter, raw);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // The host alone, so a live subscription from a host not yet allowed
    // shows which one to add: never the path, which is the app's.
    let host = "";
    try {
      host = new URL(raw).hostname;
    } catch {}
    console.warn(
      JSON.stringify({ event: "event_callback_refused", host, code: e.code }),
    );
    throw callbackError(
      "callback_not_allowed",
      "That callback URL won't do: it must be https on the usual port, at a public host this site sends events to.",
    );
  }
}

function ttlOf(raw: unknown): number {
  if (raw === undefined) return EVENT_TTL_DEFAULT_MS;
  if (raw === null) return EVENT_TTL_MAX_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
    throw invalid("ttlMs must be a positive number of milliseconds, or null.");
  return Math.min(
    Math.max(Math.floor(raw), EVENT_TTL_MIN_MS),
    EVENT_TTL_MAX_MS,
  );
}

async function lockBot(tx: Tx, botId: number): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`event_sub:${botId}`}))`;
}

// The bot's subscription in force, with its secret opened, or null.
async function current(
  tx: Tx,
  botId: number,
): Promise<{ id: number; url: string; secret: Buffer | null } | null> {
  const [r] = await tx<
    { id: string; callback_url: string | null; live: boolean }[]
  >`
    SELECT id, callback_url, event_sub_live(${botId}) AS live
    FROM event_subscriptions WHERE bot_id = ${botId} ORDER BY id DESC LIMIT 1`;
  if (!r?.live || !r.callback_url) return null;
  const [s] = await tx<{ key_version: number; iv: Buffer; sealed: Buffer }[]>`
    SELECT key_version, iv, sealed FROM event_secrets WHERE subscription_id = ${r.id}`;
  return {
    id: Number(r.id),
    url: r.callback_url,
    secret: s ? openSecret(botId, Number(r.id), s) : null,
  };
}

const same = (a: Buffer | null, b: Buffer) =>
  a !== null && a.length === b.length && timingSafeEqual(a, b);

export type Subscribed = {
  id: string;
  refreshBefore: string;
  cursor: null;
  truncated: false;
};

// events/subscribe. A new callback, or a new secret, is proved first with
// the signed challenge, and so is a paused subscription; refreshing one in
// force with the same callback and secret isn't, since nothing it proved
// has changed. All are under the set_push_url gate. One with a challenge
// counts against the bot's hourly push URL limit and the site-wide events
// cap before anything goes out, so it can't be used to make the site call
// an address over and over; a refresh, which an app makes on its own
// schedule and which calls nothing, counts against a looser limit of its
// own.
export async function subscribe(
  caller: Caller,
  params: Params,
  ipHash: string,
): Promise<Subscribed> {
  assertWritable();
  checkEvent(params);
  const delivery = deliveryOf(params);
  const key = secretBytes(delivery.secret);
  if (!key)
    throw invalid(
      "delivery.secret must be whsec_ then base64 of 24 to 64 bytes.",
    );
  const ttl = ttlOf(params.ttlMs);
  const url = checkCallback(delivery.url as string);
  if (!wakeSecretsAvailable())
    throw new EventsError(
      -32603,
      "Events aren't available on this site right now.",
    );
  const subId = subscriptionId(caller.botId, url);
  const verify = await db().begin(async (tx) => {
    await lockBot(tx, caller.botId);
    await assertAllowed(tx, caller.botId, "set_push_url");
    const cur = await current(tx, caller.botId);
    // A paused subscription isn't refreshed: it's proved again, and a
    // callback that answers starts with a clean record, which is the only
    // way a pause on events lifts.
    const [st] = await tx<{ failures: number }[]>`
      SELECT failures FROM event_sub_state WHERE bot_id = ${caller.botId}`;
    const paused = (st?.failures ?? 0) >= PUSH_MAX_FAILURES;
    const refresh =
      cur !== null && !paused && cur.url === url && same(cur.secret, key);
    if (refresh) {
      await consume(tx, eventRefreshRules(caller.botId));
      return false;
    }
    await consume(tx, pushUrlRules(caller.botId));
    await consume(tx, mcpEventRules(await antiAbuse(tx)));
    return true;
  });
  if (verify) {
    const r = await sendChallenge(url, subId, key);
    if (!r.ok)
      throw callbackError(
        r.reason,
        r.reason === "challenge_failed"
          ? "The callback didn't echo the challenge."
          : r.reason === "timeout"
            ? "The callback didn't answer in time."
            : "The callback couldn't be reached.",
      );
  }
  return db().begin(async (tx) => {
    await lockBot(tx, caller.botId);
    const before = await current(tx, caller.botId);
    const [row] = await tx<{ id: string; expires_at: Date }[]>`
      INSERT INTO event_subscriptions (bot_id, key_id, sub_id, callback_url, expires_at)
      VALUES (${caller.botId}, ${caller.keyId}, ${subId}, ${url},
              now() + make_interval(secs => ${ttl / 1000}))
      RETURNING id, expires_at`;
    if (!row) throw new Error("no subscription row");
    const rowId = Number(row.id);
    // The secret it replaces goes, unless a refresh changed it: then it
    // still signs for a little while beside the new one.
    await tx`DELETE FROM event_secrets WHERE bot_id = ${caller.botId} AND retire_at <= now()`;
    if (before && before.url === url && !same(before.secret, key))
      await tx`
        UPDATE event_secrets
        SET retire_at = now() + ${RETIRE_OLD_SECRET}::interval
        WHERE bot_id = ${caller.botId} AND retire_at IS NULL`;
    else
      await tx`
        DELETE FROM event_secrets
        WHERE bot_id = ${caller.botId} AND retire_at IS NULL`;
    const sealed = sealSecret(caller.botId, rowId, key);
    await tx`
      INSERT INTO event_secrets (subscription_id, bot_id, key_id, key_version, iv, sealed)
      VALUES (${rowId}, ${caller.botId}, ${caller.keyId}, ${sealed.key_version},
              ${sealed.iv}, ${sealed.sealed})`;
    // A callback just proved starts with a clean record.
    if (verify)
      await tx`
        INSERT INTO event_sub_state (bot_id) VALUES (${caller.botId})
        ON CONFLICT (bot_id) DO UPDATE SET last_status = NULL, failures = 0`;
    await logAction(tx, {
      action: "event.subscribe",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${caller.handle}`,
      ipHash,
      detail: { host: new URL(url).hostname, verified: verify },
    });
    return {
      id: subId,
      refreshBefore: row.expires_at.toISOString(),
      cursor: null,
      truncated: false,
    };
  });
}

// events/unsubscribe: ends the calling bot's subscription when it names the
// one in force, and is safe to repeat. One for another callback, or another
// bot's, changes nothing and answers the same. Not counted, so it always
// works.
export async function unsubscribe(
  caller: Caller,
  params: Params,
  ipHash: string,
): Promise<Record<string, never>> {
  assertWritable();
  checkEvent(params);
  const delivery = deliveryOf(params);
  let url: string;
  try {
    url = checkRegistration(mcpEventsAdapter, delivery.url as string);
  } catch (e) {
    if (e instanceof ApiError) return {};
    throw e;
  }
  const subId = subscriptionId(caller.botId, url);
  await db().begin(async (tx) => {
    await lockBot(tx, caller.botId);
    const [r] = await tx<{ sub_id: string | null }[]>`
      SELECT sub_id FROM event_subscriptions
      WHERE bot_id = ${caller.botId} ORDER BY id DESC LIMIT 1`;
    if (r?.sub_id !== subId) return;
    await endSubscription(tx, caller.botId, "unsubscribed", {
      keyId: caller.keyId,
      ipHash,
    });
  });
  return {};
}

// What a bot is told of its own subscription, and only it: whether one
// works, and how the last event went. Never the callback or the secret.
export type EventSubState = {
  set: boolean;
  paused: boolean;
};

export async function eventSubStateOf(
  sql: Tx | ReturnType<typeof db>,
  botId: number,
  maxFailures: number,
): Promise<EventSubState> {
  const [r] = await sql<{ live: boolean; failures: number | null }[]>`
    SELECT event_sub_live(${botId}) AS live,
           (SELECT failures FROM event_sub_state WHERE bot_id = ${botId}) AS failures`;
  if (!r?.live) return { set: false, paused: false };
  return { set: true, paused: (r.failures ?? 0) >= maxFailures };
}
