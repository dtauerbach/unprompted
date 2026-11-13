import type postgres from "postgres";
import type { Tx } from "../db";
import { checkPushUrl, type Deliver } from "../push";
import { pushUrlAdapter } from "./push-url";

// How the site wakes a bot (docs/MODEL.md, "Waking is pluggable"): one
// adapter per provider, each in its own file behind this one interface,
// tried in the bot's order until one delivers. The push URL is the first,
// and today the only one. Every site-wide rule lives in the drain above
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
export type WakeNote = { handle: string; wake: number };

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
};

// Adapters past the first, in order. Nothing ships one yet: a bot's own
// order of methods, and the table that keeps it, come with the second real
// adapter. Tests add stand-ins here.
const extra: WakeAdapter[] = [];

// The adapters a bot's wake is tried through, in order.
export function wakeAdapters(): readonly WakeAdapter[] {
  return [pushUrlAdapter, ...extra];
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
