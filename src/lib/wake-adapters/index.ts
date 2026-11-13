import type postgres from "postgres";
import type { Tx } from "../db";
import type { Rule } from "../limits";
import { checkPushUrl, type Deliver } from "../push";
import { mcpEventsAdapter } from "./mcp-events";
import { pushUrlAdapter } from "./push-url";

// How the site wakes a bot (docs/MODEL.md, "Waking is pluggable"): one
// adapter per provider, each in its own file behind this one interface,
// tried in the bot's order until one delivers: an app's subscription to MCP
// events (./mcp-events.ts), then the push URL. Every site-wide rule lives in the drain above
// the adapters (src/lib/push.ts): which bots are due, the per-bot gap, the
// per-host cap, the pause after repeated failures, a deadline on every
// send, and a check that the address is public, made both when a
// registration is saved (checkRegistration below) and again before each
// send; an adapter reaches the network only through the drain's deliver,
// which connects only to public addresses and follows no redirects. The
// kill switch stops the drain before it starts, both where a write kicks it
// (src/lib/push-kick.ts) and in the drain itself (src/lib/push.ts).

// What a wake carries: the bot's handle and its new wake number, nothing
// more.
export type WakeNote = {
  handle: string;
  wake: number;
  // The counter's durable occurrence time, not this delivery attempt's time.
  // Optional for adapters that do not carry an event timestamp.
  changedAt?: Date | null;
};

export type WakeOutcome = {
  delivered: boolean;
  // The HTTP status, or null when nothing answered.
  status: number | null;
  error?: string;
};

// One bot's registration with one adapter, as the adapter finds it.
export type WakeRegistration = {
  // Where the wake goes: an https URL, held to the push checks.
  address: string;
  // The adapter's own material for signing or addressing the wake.
  secret: string;
  // Failures in a row; the drain pauses the method past PUSH_MAX_FAILURES.
  failures: number;
  // The method's own gap: no send before this. The drain holds a bot whose
  // only methods are waiting until the first is due, so arrivals in
  // between go out as one.
  notBefore?: Date | null;
};

export type WakeAdapter = {
  // Short and stable, for the log and the tests.
  readonly name: string;
  // The adapter's own rules on an address, after the push checks: the
  // normal form it keeps, or an ApiError saying why not.
  check(address: string): string;
  // The bot's live registration with this adapter, or null.
  find(sql: postgres.Sql | Tx, botId: number): Promise<WakeRegistration | null>;
  // Sends one wake. Only through deliver, so the site's rules on addresses
  // and redirects hold; the drain bounds how long it may take.
  send(
    registration: WakeRegistration,
    note: WakeNote,
    deliver: Deliver,
  ): Promise<WakeOutcome>;
  // Keeps how a send went, for the next pause check.
  record(sql: postgres.Sql, botId: number, outcome: WakeOutcome): Promise<void>;
  // The cap its sends count against, and the name the drain knows it by
  // within a round. Without one, the public per-host cap on the address's
  // host. An adapter whose every bot sends to one provider's hosts gives a
  // site-wide cap of its own instead, so they aren't one public bucket.
  cap?(tx: Tx): Promise<{ key: string; rules: Rule[] }>;
  // When to try again after a send that failed, read after record(), or
  // null not to. Without one, a failed wake isn't retried: the next arrival
  // queues the next. The retries stop at the method's own pause.
  retryAt?(
    sql: postgres.Sql,
    botId: number,
    outcome: WakeOutcome,
  ): Promise<Date | null>;
  // Clears what its registrations no longer need once their time is past,
  // run by the drain at most once a minute in a process, when it's already
  // at the database.
  sweep?(sql: postgres.Sql): Promise<void>;
};

// Stand-ins tests add after the real adapters.
const extra: WakeAdapter[] = [];

// The adapters a bot's wake is tried through, in order: MCP events, then
// the push URL. The order is the code's, and a bot's own order, with a
// table to keep it, waits until bots ask to rank them differently. Events
// go first because a subscription is the app asking to be woken in the
// bot's own run, which a push only reaches through a listener; while
// events wait out their gap of minutes, or fail, the push URL still goes.
export function wakeAdapters(): readonly WakeAdapter[] {
  return [mcpEventsAdapter, pushUrlAdapter, ...extra];
}

// Whether a test has added a stand-in. The drain can't ask a stand-in in
// SQL whether it could wake a bot paused on its push URL, so while one is
// added such a bot is claimed, as every bot was before the real second
// adapter came.
export function standIns(): boolean {
  return extra.length > 0;
}

// Adds an adapter after the others; the function it returns takes it off.
export function addWakeAdapter(adapter: WakeAdapter): () => void {
  extra.push(adapter);
  return () => {
    const i = extra.indexOf(adapter);
    if (i >= 0) extra.splice(i, 1);
  };
}

// The one way an address becomes a registration: the push checks first,
// then the adapter's own, then the push checks again on what the adapter
// kept, so no adapter can register an address the push checks refuse.
export function checkRegistration(adapter: WakeAdapter, raw: string): string {
  return checkPushUrl(adapter.check(checkPushUrl(raw)));
}
