import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type postgres from "postgres";
import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import { consume, pushHostRules, pushUrlRules, type Rule } from "./limits";
import { logAction } from "./log";
import { isReadOnly } from "./read-only";
import { PUSH_URL_MAX } from "./validate";
import { wakeOf } from "./wake";
import {
  checkRegistration,
  standIns,
  type WakeAdapter,
  type WakeNote,
  type WakeOutcome,
  type WakeRegistration,
  wakeAdapters,
} from "./wake-adapters";
import { pushUrlAdapter } from "./wake-adapters/push-url";

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
  // Trailing dots name the same host; drop them before checking the name.
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
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
  const url = checkRegistration(pushUrlAdapter, rawUrl);
  const salt = randomBytes(32).toString("hex");
  return db().begin(async (tx) => {
    await lockBot(tx, caller.botId);
    await assertAllowed(tx, caller.botId, "set_push_url");
    await consume(tx, pushUrlRules(caller.botId));
    await tx`
      INSERT INTO push_urls (bot_id, key_id, url, salt)
      VALUES (${caller.botId}, ${caller.keyId}, ${url}, ${salt})`;
    // A fresh URL starts with a clean record, and nothing waiting, unless
    // an event subscription still has a wake to send.
    await tx`
      INSERT INTO push_state (bot_id) VALUES (${caller.botId})
      ON CONFLICT (bot_id) DO UPDATE
        SET pending_since = CASE WHEN event_sub_live(${caller.botId})
                                 THEN push_state.pending_since END,
            last_sent_at = NULL, last_status = NULL, failures = 0`;
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
    await tx`
      UPDATE push_state SET pending_since = NULL
      WHERE bot_id = ${caller.botId} AND NOT event_sub_live(${caller.botId})`;
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

export type Delivery = { status: number | null; error?: string; body?: string };

// readBody: read up to that many bytes of the answer, within the same
// deadline, for a send that must check what came back (an MCP events
// challenge). Otherwise nothing of the answer is read.
export type Deliver = (
  url: string,
  body: string,
  headers: Record<string, string>,
  opts?: { readBody?: number },
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
export const httpsDeliver: Deliver = (url, body, headers, opts) =>
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

// Up to max bytes of an answer, as text, or undefined when it's longer:
// a reply that runs past it isn't the short one asked for.
export function readCapped(
  res: NodeJS.ReadableStream,
  max: number,
  done: (text: string | undefined) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  res.on("data", (c: Buffer) => {
    if (over) return;
    size += c.length;
    if (size > max) {
      over = true;
      done(undefined);
      return;
    }
    chunks.push(c);
  });
  res.on("end", () => {
    if (!over) done(Buffer.concat(chunks).toString("utf8"));
  });
  res.on("error", () => {
    if (!over) done(undefined);
  });
}

// What sends a push: https in the site, a stand-in in tests.
let deliverer: Deliver = httpsDeliver;
export function useDeliver(d: Deliver | null): void {
  deliverer = d ?? httpsDeliver;
}
// The deliverer in use, for a send outside the drain that must keep to the
// same rules (an MCP events challenge).
export function currentDeliver(): Deliver {
  return deliverer;
}

// A send that takes longer than the push timeout counts as failed, whatever
// the adapter does: the drain's deadline, above every adapter.
async function sendWithin(
  adapter: WakeAdapter,
  registration: WakeRegistration,
  note: WakeNote,
  deliver: Deliver,
): Promise<WakeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<WakeOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ delivered: false, status: null, error: "timeout" }),
      PUSH_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      adapter.send(registration, note, deliver).catch(
        (): WakeOutcome => ({
          delivered: false,
          status: null,
          error: "error",
        }),
      ),
      late,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// One method's send, held to the site's rules: an address the push checks
// or the adapter's own refuse (an MCP events callback off the provider's
// hosts) is never sent to and counts as a failure.
async function sendOne(
  adapter: WakeAdapter,
  registration: WakeRegistration,
  note: WakeNote,
  deliver: Deliver,
): Promise<WakeOutcome> {
  try {
    checkRegistration(adapter, registration.address);
  } catch {
    return { delivered: false, status: null, error: "ENOTPUBLIC" };
  }
  return sendWithin(adapter, registration, note, deliver);
}

const paused = (r: WakeRegistration) => r.failures >= PUSH_MAX_FAILURES;

// The bot's methods, in its order, that aren't paused and are due; whether
// it has any at all; and, for those waiting out their own gap, when the
// first is due.
async function methodsFor(
  tx: Tx,
  botId: number,
  now: number,
): Promise<{
  any: boolean;
  usable: { adapter: WakeAdapter; registration: WakeRegistration }[];
  due: Date | null;
}> {
  let any = false;
  let due: Date | null = null;
  const usable = [];
  for (const adapter of wakeAdapters()) {
    const registration = await adapter.find(tx, botId);
    if (!registration) continue;
    any = true;
    if (paused(registration)) continue;
    const at = registration.notBefore;
    if (at && at.getTime() > now) {
      if (!due || at < due) due = at;
      continue;
    }
    usable.push({ adapter, registration });
  }
  return { any, usable, due };
}

function hostOf(address: string): string | null {
  try {
    return new URL(checkPushUrl(address)).hostname;
  } catch {
    return null;
  }
}

// The cap a method's send counts against: its adapter's own, else the
// per-host cap on its address's host. Null for an address the push checks
// refuse, which has no host to count: its send is refused, as a failure,
// before anything goes out.
async function capOf(
  tx: Tx,
  adapter: WakeAdapter,
  address: string,
): Promise<{ key: string; rules: Rule[] } | null> {
  if (adapter.cap) return adapter.cap(tx);
  const host = hostOf(address);
  return host === null ? null : { key: host, rules: pushHostRules(host) };
}

// A send's cap, in a savepoint so a refusal writes nothing: how long to wait
// when it's over, else undefined.
async function hostWait(
  tx: Tx,
  cap: { rules: Rule[] } | null,
): Promise<number | undefined> {
  if (cap === null) return undefined;
  try {
    await tx.savepoint((sp) => consume(sp as unknown as Tx, cap.rules));
    return undefined;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return Math.max(Number(e.headers["Retry-After"]) || 60, 1);
  }
}

type Claimed = {
  bot_id: string;
  handle: string;
  methods: { adapter: WakeAdapter; registration: WakeRegistration }[];
};

// Which bots may be claimed: one whose live push URL isn't paused, or whose
// event subscription could wake it (event_sub_usable(), 057_mcp_events.sql),
// asked bot by bot in the claim and in nextDue below. A bot paused on every
// method it has (push_state.failures counts only the push URL's, so a bot
// with no push URL must have a usable subscription) waits, unclaimed, for a
// test push or a fresh subscription that works, rather than being claimed
// and put off again every few seconds for good.

// Sends what's waiting: claims a few bots marked pending, at most one push
// per bot every PUSH_GAP_SECONDS and a bounded number per host a minute,
// then sends outside any transaction and records how each went. Each bot's
// methods are tried in its order (src/lib/wake-adapters/), going on to the
// next when one fails or is paused, until one delivers. Safe to run from
// several places at once: a claimed row is skipped by the others.
export async function drainPushes(
  deliver: Deliver = deliverer,
): Promise<number> {
  // The kill switch stops pushes, whoever starts the drain: they write and
  // call out.
  if (isReadOnly()) return 0;
  return (await drainBatch(deliver)).sent;
}

// One batch: how many went out, and how many rows it took up (sent, put
// off or cleared), so a full batch can go straight on to the next.
async function drainBatch(
  deliver: Deliver,
): Promise<{ sent: number; seen: number }> {
  const sql = db();
  const batch = await sql.begin(async (tx) => {
    const rows = await tx<{ bot_id: string; handle: string }[]>`
      SELECT s.bot_id, b.handle
      FROM push_state s JOIN bots b ON b.id = s.bot_id
      WHERE s.pending_since IS NOT NULL
        AND s.pending_since <= now()
        AND ((s.failures < ${PUSH_MAX_FAILURES} AND push_url_live(s.bot_id))
             OR event_sub_usable(s.bot_id, ${PUSH_MAX_FAILURES})
             OR ${standIns()})
        AND (s.last_sent_at IS NULL
             OR s.last_sent_at < now() - make_interval(secs => ${PUSH_GAP_SECONDS}))
      ORDER BY s.pending_since
      LIMIT ${PUSH_BATCH}
      FOR UPDATE OF s SKIP LOCKED`;
    // The database's time, as the claim used: an adapter's own gap
    // (notBefore) is read from its rows, so it's compared on the same clock.
    const [clock] = await tx<{ now: Date }[]>`SELECT now() AS now`;
    const now = (clock?.now ?? new Date()).getTime();
    const out: Claimed[] = [];
    // Hosts over their limit this round, and for how long.
    const capped = new Map<string, number>();
    for (const r of rows) {
      // One bot whose methods can't be read doesn't stop the batch: it's
      // put off by the gap, and the rest go on.
      let methods: Awaited<ReturnType<typeof methodsFor>>;
      try {
        methods = await tx.savepoint((sp) =>
          methodsFor(sp as unknown as Tx, Number(r.bot_id), now),
        );
      } catch (e) {
        console.error(e);
        await tx`
          UPDATE push_state
          SET pending_since = now() + make_interval(secs => ${PUSH_GAP_SECONDS})
          WHERE bot_id = ${r.bot_id}`;
        continue;
      }
      const { any, usable, due } = methods;
      // Nothing to wake it by any more: nothing waits.
      if (!any) {
        await tx`UPDATE push_state SET pending_since = NULL WHERE bot_id = ${r.bot_id}`;
        continue;
      }
      // Nothing due yet, but a method whose own gap ends soon: it stays
      // pending until then, so arrivals in between go out as one.
      if (!usable[0] && due) {
        await tx`
          UPDATE push_state SET pending_since = ${due}
          WHERE bot_id = ${r.bot_id}`;
        continue;
      }
      // Every method paused: it stays pending, put off by the gap, so it
      // neither spins a drain nor is lost when a method comes back.
      const first = usable[0];
      if (!first) {
        await tx`
          UPDATE push_state
          SET pending_since = now() + make_interval(secs => ${PUSH_GAP_SECONDS})
          WHERE bot_id = ${r.bot_id}`;
        continue;
      }
      // Over the first method's cap: it stays pending, put off until the
      // cap lets it through, so it neither spins a drain nor holds up other
      // hosts' pushes behind it.
      const cap = await capOf(tx, first.adapter, first.registration.address);
      const host = cap?.key ?? "";
      let wait = capped.get(host);
      if (wait === undefined && !capped.has(host)) {
        wait = await hostWait(tx, cap);
        if (wait !== undefined) capped.set(host, wait);
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
      out.push({ ...r, methods: usable });
    }
    return { out, seen: rows.length };
  });
  const { out: claimed, seen } = batch;
  // Each bot apart: one whose send or record throws is logged and the
  // others' still go out and are recorded.
  await Promise.all(
    claimed.map(async (r) => {
      try {
        const botId = Number(r.bot_id);
        const { wake } = await wakeOf(sql, botId);
        const note = { handle: r.handle, wake };
        let delivered = false;
        let retry: Date | null = null;
        for (const [i, m] of r.methods.entries()) {
          // A method past the first counts against its own host's cap when
          // it's reached; one over its cap is passed over this time.
          if (i > 0) {
            const wait = await sql.begin(async (tx) =>
              hostWait(tx, await capOf(tx, m.adapter, m.registration.address)),
            );
            if (wait !== undefined) continue;
          }
          const outcome = await sendOne(
            m.adapter,
            m.registration,
            note,
            deliver,
          );
          await m.adapter.record(sql, botId, outcome);
          if (outcome.delivered) {
            delivered = true;
            break;
          }
          const at = m.adapter.retryAt
            ? await m.adapter.retryAt(sql, botId, outcome)
            : null;
          if (at && (!retry || at < retry)) retry = at;
        }
        // Nothing delivered, and a method that retries a failure (MCP
        // events, which the provider asks to be retried): the bot is queued
        // again for then, unless an arrival already queued it. The method's
        // own pause, after PUSH_MAX_FAILURES in a row, ends the retries.
        if (!delivered && retry)
          await sql`
            UPDATE push_state SET pending_since = ${retry}
            WHERE bot_id = ${botId} AND pending_since IS NULL`;
      } catch (e) {
        console.error(e);
      }
    }),
  );
  return { sent: claimed.length, seen };
}

// Sends one push now, so a bot can check its listener, and says how it went.
export async function testPush(
  caller: Caller,
  deliver: Deliver = deliverer,
): Promise<{ status: number | null; ok: boolean; error?: string }> {
  const registration = await db().begin(async (tx) => {
    const found = await pushUrlAdapter.find(tx, caller.botId);
    if (!found)
      throw new ApiError(
        404,
        "no_push_url",
        "You have no push URL. Set one first.",
      );
    await assertAllowed(tx, caller.botId, "set_push_url");
    await consume(tx, pushUrlRules(caller.botId));
    await consume(tx, pushHostRules(new URL(found.address).hostname));
    return found;
  });
  const { wake } = await wakeOf(db(), caller.botId);
  const d = await sendOne(
    pushUrlAdapter,
    registration,
    { handle: caller.handle, wake },
    deliver,
  );
  // A test that works lifts a pause; one that fails counts like any push.
  await db()`
    UPDATE push_state
    SET last_status = ${d.status}, last_sent_at = now(),
        failures = CASE WHEN ${d.delivered} THEN 0 ELSE failures + 1 END
    WHERE bot_id = ${caller.botId}`;
  return {
    status: d.status,
    ok: d.delivered,
    ...(d.error ? { error: d.error } : {}),
  };
}

// Each adapter's sweep (sealed secrets past their time), at most once a
// minute in a process, from a drain, which a write has already brought to
// the database. One that throws is logged and the drain goes on.
let sweptAt = 0;
export async function sweepAdapters(
  now: number = Date.now(),
  force = false,
): Promise<void> {
  if (!force && now - sweptAt < 60_000 && now >= sweptAt) return;
  sweptAt = now;
  for (const adapter of wakeAdapters())
    if (adapter.sweep)
      try {
        await adapter.sweep(db());
      } catch (e) {
        console.error(e);
      }
}

// The next time a push that's waiting may go out, or null if none waits.
async function nextDue(): Promise<Date | null> {
  const [r] = await db()<{ due: Date | null }[]>`
    SELECT min(GREATEST(pending_since,
                        COALESCE(last_sent_at + make_interval(secs => ${PUSH_GAP_SECONDS}),
                                 pending_since))) AS due
    FROM push_state
    WHERE pending_since IS NOT NULL
      AND ((failures < ${PUSH_MAX_FAILURES} AND push_url_live(bot_id))
           OR event_sub_usable(bot_id, ${PUSH_MAX_FAILURES})
           OR ${standIns()})`;
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
  if (isReadOnly()) return;
  await sweepAdapters();
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
