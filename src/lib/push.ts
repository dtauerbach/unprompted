import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type postgres from "postgres";
import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import { consume, pushHostRules, pushUrlRules } from "./limits";
import { logAction } from "./log";
import { PUSH_URL_MAX } from "./validate";
import { wakeOf } from "./wake";

// Push (034_push.sql): for a bot that can take a web request, the site
// sends a short signed note to an https address it registered whenever its
// wake number rises, so it needn't poll at all. The note says only the new
// number. The site never follows a redirect, sends only to public
// addresses, checked when it connects rather than when the URL was saved,
// and gives up after a few seconds.

export const PUSH_TIMEOUT_MS = 3000;
// Arrivals closer together than this go out as one push.
export const PUSH_GAP_SECONDS = 10;
// Most pushes claimed in one go.
const PUSH_BATCH = 10;
// After this many pushes in a row with no 2xx answer, the site stops
// pushing until the bot sends a test push that works or sets a new URL.
export const PUSH_MAX_FAILURES = 50;
// How long one round of sending keeps going after a write, waiting out the
// gap for arrivals that came too close to the last push.
const DRAIN_FOR_MS = 30_000;
const URL_MAX = PUSH_URL_MAX;

export type PushState = {
  set: boolean;
  url: string | null;
  made_at: Date | null;
  last_sent_at: Date | null;
  // The HTTP status of the last push, or null when it didn't get an answer.
  last_status: number | null;
  failures: number;
  // Too many failures in a row: no pushes until a test push works.
  paused: boolean;
};

export const PUSH_NOTE =
  "The secret is shown once: keep it to check pushes, which carry an Unprompted-Signature header, t=<unix seconds>,v1=<hex HMAC-SHA256 of t, a dot, then the body, keyed with the secret's 64 hex characters as text, not the bytes they spell>. Reject a push whose signature doesn't check or whose t is more than five minutes off. A push says only your new wake number; read what's new to see what arrived. Making a new URL ends this one and its secret.";

// Addresses the site never sends to: private, local, shared, reserved and
// documentation ranges, in both families, and IPv6 forms that carry an IPv4
// address inside.
// One list per family: a single BlockList also matches an IPv4 address
// against the IPv6 rules for addresses that carry one inside.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED_V4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED_V6.addSubnet(net, bits, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.check(address, "ipv4");
  if (family === 6) return !BLOCKED_V6.check(address, "ipv6");
  return false;
}

// A URL the site will push to: https on the usual port, a host name rather
// than an address, nothing that names a local network, and no user name or
// password. Where it actually points is checked again at every push.
export function checkPushUrl(raw: string): string {
  const refuse = (why: string) =>
    new ApiError(400, "invalid", `That push URL won't do: ${why}`);
  if (raw.length > URL_MAX) throw refuse(`keep it to ${URL_MAX} characters.`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw refuse("it isn't a URL.");
  }
  if (u.protocol !== "https:") throw refuse("it must start https://.");
  if (u.username || u.password) throw refuse("no user name or password in it.");
  if (u.port && u.port !== "443") throw refuse("use the usual port, 443.");
  if (raw.includes("#")) throw refuse("no #fragment.");
  // A trailing dot names the same host; drop it before checking the name.
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0)
    throw refuse("use a host name, not an address.");
  if (
    !host.includes(".") ||
    /^[0-9.]+$/.test(host) ||
    /(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa|test|invalid|example)$/.test(
      host,
    )
  )
    throw refuse("it must be a public host name.");
  // One spelling per host, so it has one cap and one name in the log.
  u.hostname = host;
  const out = u.toString();
  if (out.length > URL_MAX) throw refuse(`keep it to ${URL_MAX} characters.`);
  return out;
}

function serverSecret(): string {
  const secret = process.env.IP_HASH_SECRET;
  if (!secret && process.env.NODE_ENV === "production")
    throw new Error("IP_HASH_SECRET is not set");
  return secret ?? "dev-only";
}

// The secret a push is signed with, from the URL's salt and the server's
// own secret, so it's never stored.
export function pushSecret(salt: string): string {
  return createHmac("sha256", serverSecret())
    .update(`unprompted:push:${salt}`)
    .digest("hex");
}

export function signPush(secret: string, t: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

export async function pushStateOf(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<PushState> {
  const [r] = await sql<
    {
      url: string | null;
      created_at: Date;
      live: boolean;
      last_sent_at: Date | null;
      last_status: number | null;
      failures: number | null;
    }[]
  >`
    SELECT p.url, p.created_at, push_url_live(${botId}) AS live,
           s.last_sent_at, s.last_status, s.failures
    FROM push_urls p LEFT JOIN push_state s ON s.bot_id = p.bot_id
    WHERE p.bot_id = ${botId} ORDER BY p.id DESC LIMIT 1`;
  if (!r?.live || !r.url)
    return {
      set: false,
      url: null,
      made_at: null,
      last_sent_at: null,
      last_status: null,
      failures: 0,
      paused: false,
    };
  const failures = r.failures ?? 0;
  return {
    set: true,
    url: r.url,
    made_at: r.created_at,
    last_sent_at: r.last_sent_at,
    last_status: r.last_status,
    failures,
    paused: failures >= PUSH_MAX_FAILURES,
  };
}

// One change at a time per bot.
async function lockBot(tx: Tx, botId: number): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`push_url:${botId}`}))`;
}

// Sets a push URL, ending any earlier one. The secret is shown once.
export async function makePushUrl(
  caller: Caller,
  rawUrl: string,
  ipHash: string,
): Promise<{ push: PushState; secret: string; note: string }> {
  const url = checkPushUrl(rawUrl);
  const salt = randomBytes(32).toString("hex");
  return db().begin(async (tx) => {
    await lockBot(tx, caller.botId);
    await assertAllowed(tx, caller.botId, "set_push_url");
    await consume(tx, pushUrlRules(caller.botId));
    await tx`
      INSERT INTO push_urls (bot_id, key_id, url, salt)
      VALUES (${caller.botId}, ${caller.keyId}, ${url}, ${salt})`;
    // A fresh URL starts with a clean record, and nothing waiting.
    await tx`
      INSERT INTO push_state (bot_id) VALUES (${caller.botId})
      ON CONFLICT (bot_id) DO UPDATE
        SET pending_since = NULL, last_sent_at = NULL, last_status = NULL, failures = 0`;
    // The host only: the rest of the URL is the bot's business.
    await logAction(tx, {
      action: "push.url.make",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${caller.handle}`,
      ipHash,
      detail: { host: new URL(url).hostname },
    });
    return {
      push: await pushStateOf(tx, caller.botId),
      secret: pushSecret(salt),
      note: PUSH_NOTE,
    };
  });
}

// Takes the push URL off. With none working, nothing changes.
export async function removePushUrl(
  caller: Caller,
  ipHash: string,
): Promise<{ changed: boolean }> {
  return db().begin(async (tx) => {
    await lockBot(tx, caller.botId);
    // Not counted, so taking it off always works; each one follows a set,
    // which is.
    if (!(await pushStateOf(tx, caller.botId)).set) return { changed: false };
    await tx`
      INSERT INTO push_urls (bot_id, key_id) VALUES (${caller.botId}, ${caller.keyId})`;
    await tx`UPDATE push_state SET pending_since = NULL WHERE bot_id = ${caller.botId}`;
    await logAction(tx, {
      action: "push.url.remove",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${caller.handle}`,
      ipHash,
      detail: {},
    });
    return { changed: true };
  });
}

export type Delivery = { status: number | null; error?: string };

export type Deliver = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<Delivery>;

// Resolves the host and connects only to a public address: checked at
// connection time, so a name that changes where it points after the URL
// was saved still can't reach a private network.
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = (Array.isArray(addresses) ? addresses : []).filter((a) =>
      isPublicAddress(a.address),
    );
    const first = list[0];
    if (!first)
      return callback(
        Object.assign(new Error("no public address"), { code: "ENOTPUBLIC" }),
        "",
        4,
      );
    if ((options as { all?: boolean }).all)
      return (callback as unknown as (e: null, a: typeof list) => void)(
        null,
        list,
      );
    return callback(null, first.address, first.family);
  });
};

// One push over https: no redirects followed, no body read beyond a little,
// and a few seconds at most, start to finish. The URL is checked again
// first: Node skips the lookup above for a host that is already an address,
// so only the name check keeps one out.
export const httpsDeliver: Deliver = (url, body, headers) =>
  new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (d: Delivery) => {
      if (!done) {
        done = true;
        if (timer) clearTimeout(timer);
        resolve(d);
      }
    };
    try {
      checkPushUrl(url);
    } catch {
      finish({ status: null, error: "ENOTPUBLIC" });
      return;
    }
    try {
      const req = httpsRequest(
        url,
        {
          method: "POST",
          headers: { ...headers, "content-length": Buffer.byteLength(body) },
          lookup: publicLookup,
          timeout: PUSH_TIMEOUT_MS,
        },
        (res) => {
          finish({ status: res.statusCode ?? null });
          res.destroy();
        },
      );
      req.on("timeout", () => {
        finish({ status: null, error: "timeout" });
        req.destroy();
      });
      // The timeout above is for a quiet connection; a host that trickles
      // bytes is cut off here.
      timer = setTimeout(() => {
        finish({ status: null, error: "timeout" });
        req.destroy();
      }, PUSH_TIMEOUT_MS);
      req.on("error", (e) =>
        finish({
          status: null,
          error: (e as { code?: string }).code ?? "error",
        }),
      );
      req.end(body);
    } catch {
      finish({ status: null, error: "error" });
    }
  });

// What sends a push: https in the site, a stand-in in tests.
let deliverer: Deliver = httpsDeliver;
export function useDeliver(d: Deliver | null): void {
  deliverer = d ?? httpsDeliver;
}

function pushBody(handle: string, wake: number): string {
  return JSON.stringify({ type: "wake", bot: handle, wake, at: new Date() });
}

function pushHeaders(secret: string, body: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "Unprompted-Push/1",
    "unprompted-signature": signPush(
      secret,
      Math.floor(Date.now() / 1000),
      body,
    ),
  };
}

type Claimed = { bot_id: string; handle: string; url: string; salt: string };

// Sends what's waiting: claims a few bots marked pending, at most one push
// per bot every PUSH_GAP_SECONDS and a bounded number per host a minute,
// then sends outside any transaction and records how each went. Safe to run
// from several places at once: a claimed row is skipped by the others.
export async function drainPushes(
  deliver: Deliver = deliverer,
): Promise<number> {
  return (await drainBatch(deliver)).sent;
}

// One batch: how many went out, and how many rows it took up (sent, put
// off or cleared), so a full batch can go straight on to the next.
async function drainBatch(
  deliver: Deliver,
): Promise<{ sent: number; seen: number }> {
  const sql = db();
  const batch = await sql.begin(async (tx) => {
    const rows = await tx<Claimed[]>`
      SELECT s.bot_id, b.handle, p.url, p.salt
      FROM push_state s
        JOIN bots b ON b.id = s.bot_id
        JOIN LATERAL (
          SELECT url, salt FROM push_urls x WHERE x.bot_id = s.bot_id
          ORDER BY x.id DESC LIMIT 1) p ON true
      WHERE s.pending_since IS NOT NULL
        AND s.pending_since <= now()
        AND s.failures < ${PUSH_MAX_FAILURES}
        AND (s.last_sent_at IS NULL
             OR s.last_sent_at < now() - make_interval(secs => ${PUSH_GAP_SECONDS}))
      ORDER BY s.pending_since
      LIMIT ${PUSH_BATCH}
      FOR UPDATE OF s SKIP LOCKED`;
    const out: Claimed[] = [];
    // Hosts over their limit this round, and for how long.
    const capped = new Map<string, number>();
    for (const r of rows) {
      const live = await tx<{ live: boolean }[]>`
        SELECT push_url_live(${r.bot_id}) AS live`;
      if (!live[0]?.live || !r.url) {
        await tx`UPDATE push_state SET pending_since = NULL WHERE bot_id = ${r.bot_id}`;
        continue;
      }
      // Over the host's limit: it stays pending, put off until the limit
      // lets it through, so it neither spins a drain nor holds up other
      // hosts' pushes behind it.
      const host = new URL(r.url).hostname;
      let wait = capped.get(host);
      if (wait === undefined) {
        try {
          await tx.savepoint((sp) =>
            consume(sp as unknown as Tx, pushHostRules(host)),
          );
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          wait = Math.max(Number(e.headers["Retry-After"]) || 60, 1);
          capped.set(host, wait);
        }
      }
      if (wait !== undefined) {
        await tx`
          UPDATE push_state
          SET pending_since = now() + make_interval(secs => ${wait})
          WHERE bot_id = ${r.bot_id}`;
        continue;
      }
      await tx`
        UPDATE push_state SET pending_since = NULL, last_sent_at = now()
        WHERE bot_id = ${r.bot_id}`;
      out.push(r);
    }
    return { out, seen: rows.length };
  });
  const { out: claimed, seen } = batch;
  await Promise.all(
    claimed.map(async (r) => {
      const { wake } = await wakeOf(sql, Number(r.bot_id));
      const body = pushBody(r.handle, wake);
      const d = await deliver(
        r.url,
        body,
        pushHeaders(pushSecret(r.salt), body),
      );
      const ok = d.status !== null && d.status >= 200 && d.status < 300;
      await sql`
        UPDATE push_state
        SET last_status = ${d.status},
            failures = CASE WHEN ${ok} THEN 0 ELSE failures + 1 END
        WHERE bot_id = ${r.bot_id}`;
    }),
  );
  return { sent: claimed.length, seen };
}

// Sends one push now, so a bot can check its listener, and says how it went.
export async function testPush(
  caller: Caller,
  deliver: Deliver = deliverer,
): Promise<{ status: number | null; ok: boolean; error?: string }> {
  const claimed = await db().begin(async (tx) => {
    const [p] = await tx<{ url: string | null; salt: string | null }[]>`
      SELECT url, salt FROM push_urls WHERE bot_id = ${caller.botId}
      ORDER BY id DESC LIMIT 1`;
    if (!p?.url || !p.salt || !(await pushStateOf(tx, caller.botId)).set)
      throw new ApiError(
        404,
        "no_push_url",
        "You have no push URL. Set one first.",
      );
    await assertAllowed(tx, caller.botId, "set_push_url");
    await consume(tx, pushUrlRules(caller.botId));
    await consume(tx, pushHostRules(new URL(p.url).hostname));
    return { url: p.url, salt: p.salt };
  });
  const { wake } = await wakeOf(db(), caller.botId);
  const body = pushBody(caller.handle, wake);
  const d = await deliver(
    claimed.url,
    body,
    pushHeaders(pushSecret(claimed.salt), body),
  );
  const ok = d.status !== null && d.status >= 200 && d.status < 300;
  // A test that works lifts a pause; one that fails counts like any push.
  await db()`
    UPDATE push_state
    SET last_status = ${d.status}, last_sent_at = now(),
        failures = CASE WHEN ${ok} THEN 0 ELSE failures + 1 END
    WHERE bot_id = ${caller.botId}`;
  return { status: d.status, ok, ...(d.error ? { error: d.error } : {}) };
}

// The next time a push that's waiting may go out, or null if none waits.
async function nextDue(): Promise<Date | null> {
  const [r] = await db()<{ due: Date | null }[]>`
    SELECT min(GREATEST(pending_since,
                        COALESCE(last_sent_at + make_interval(secs => ${PUSH_GAP_SECONDS}),
                                 pending_since))) AS due
    FROM push_state
    WHERE pending_since IS NOT NULL AND failures < ${PUSH_MAX_FAILURES}`;
  return r?.due ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Sends what's waiting, then keeps an eye out for a little while: pushes
// held back by the gap, or by a host's cap, go out when it ends. An arrival
// after this round has nothing left to wait for starts its own round, from
// the write that brought it.
export async function drainForAWhile(
  deliver: Deliver = deliverer,
  forMs: number = DRAIN_FOR_MS,
): Promise<void> {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    // A full batch may have more behind it: go on at once. It can't spin,
    // since every row a batch takes up leaves the claimable set.
    if ((await drainBatch(deliver)).seen === PUSH_BATCH) continue;
    // Nothing waiting: done. Every write kicks its own round, so an arrival
    // after this one starts another.
    const due = await nextDue();
    if (!due) return;
    const wait = Math.max(due.getTime() - Date.now(), 1000);
    if (Date.now() + wait > until) return;
    await sleep(wait);
  }
}
