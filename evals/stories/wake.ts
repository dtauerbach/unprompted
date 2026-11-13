// What a bot's wake listener counts as seen once a chat it started on a wake
// ends. The number counts arrivals, so the app keeps the last number it took
// as seen and starts a chat when the number goes past it. A chat started on a
// wake usually reads what arrived while it ran: a group message that lands
// mid-visit is in the group read the bot makes a minute later. Keeping the
// number from the start of the visit would wake the bot again for it as soon
// as the visit ends. Taking the number at the end would swallow a message
// that landed after the bot's last read. So the listener goes on reading the
// number while the chat runs (samples), and when it ends takes as seen the
// last sample that came back before the bot sent the reads that would show
// what arrived.
//
// One number counts every kind of arrival, and each read shows only some: a
// group's messages are only in that group's read, the rest (replies,
// mentions, pair messages, presence, nudges) only in the digest. So the
// listener asks the trial's database which groups had another member's
// message during the visit, and counts any rise those don't explain as
// something only the digest shows. Every place something arrived needs a
// read sent after the sample: the cutoff is the earliest of their last reads,
// and a place the bot didn't read at all in the visit keeps the number it
// started from. groupArrivals() counts a group's messages as the site's
// trigger does (another member's, not one the bot blocked), with the bot's
// groups as they stand when the visit ends: a bot moved into or out of a
// group mid-visit can skew the sum, which no trial does.
import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { HostEntry } from "./inbox";

// A wake number the listener read, and when its answer came back (epoch ms).
export type WakeSample = { at: number; wake: number };

// Where a read shows arrivals, or where one arrived: "digest", or a private
// channel as "channel:<id>". `at`: when the read was sent, or when the
// message was written (epoch ms).
export type Place = { scope: string; at: number };

// The digest, or one private channel by its id. A read that pages back
// (before=) shows older messages, not what just arrived.
export function arrivalRead(e: HostEntry): Place | undefined {
  if (e.kind !== "http" || e.method !== "GET") return undefined;
  if (typeof e.status !== "number" || e.status < 200 || e.status >= 300)
    return undefined;
  let u: URL;
  try {
    u = new URL(String(e.url));
  } catch {
    return undefined;
  }
  if (u.searchParams.has("before")) return undefined;
  const channel = /^\/v1\/private-channels\/(\d+)\/?$/.exec(u.pathname);
  const scope = /^\/v1\/me\/digest\/?$/.test(u.pathname)
    ? "digest"
    : channel
      ? `channel:${Number(channel[1])}`
      : undefined;
  if (!scope) return undefined;
  // An entry from before the host logged when it sent a request has only
  // when it answered, which may be after an arrival the read didn't show.
  const at = Date.parse(String(e.sent_at ?? ""));
  return Number.isFinite(at) ? { scope, at } : undefined;
}

// The number to take as seen once a wake visit ends.
//   prev     the number taken when the visit started
//   samples  what the listener read during it
//   reads    the bot's reads of its arrivals during it (arrivalRead)
//   groups   other members' messages in its groups, written after `prev`
//            came back
// Never lower than `prev`: the number only rises, and a lower one would only
// wake the bot again.
export function seenAfterWakeVisit(o: {
  prev: number;
  samples: WakeSample[];
  reads: Place[];
  groups: Place[];
}): number {
  const { prev } = o;
  const finite = o.samples.filter((s) => Number.isFinite(s.wake));
  if (finite.length === 0) return prev;
  const last = finite.reduce((a, s) => (s.at > a.at ? s : a));
  const counted = o.groups.filter((g) => g.at <= last.at);
  const need = new Set(counted.map((g) => g.scope));
  if (!Number.isFinite(prev) || last.wake - prev > counted.length)
    need.add("digest");
  let cutoff = Number.POSITIVE_INFINITY;
  for (const scope of need) {
    const at = o.reads
      .filter((r) => r.scope === scope)
      .reduce((m, r) => Math.max(m, r.at), Number.NEGATIVE_INFINITY);
    if (at === Number.NEGATIVE_INFINITY) return prev;
    cutoff = Math.min(cutoff, at);
  }
  // Nothing arrived: whatever the samples say, nothing new was there.
  if (need.size === 0) return prev;
  let best = prev;
  for (const s of finite)
    if (s.at <= cutoff && (!Number.isFinite(best) || s.wake > best))
      best = s.wake;
  return best;
}

// Other members' messages in the groups of the bot whose key this is,
// written after `since` (epoch ms), from the trial's own database: each a
// rise in the bot's wake number (050_group_channels.sql's wake_on_message).
export async function groupArrivals(
  sql: postgres.Sql,
  key: string,
  since: number,
): Promise<Place[]> {
  const hash = createHash("sha256").update(key).digest("hex");
  const rows = await sql`
    SELECT m.channel_id, m.created_at FROM messages m
    JOIN group_channels g ON g.channel_id = m.channel_id
    JOIN api_keys k ON k.key_hash = ${hash}
    WHERE m.to_bot_id IS NULL AND m.bot_id <> k.bot_id
      AND channel_has(m.channel_id, k.bot_id)
      AND NOT has_blocked(k.bot_id, m.bot_id)
      AND m.created_at > ${new Date(since)}`;
  return rows.map((r) => ({
    scope: `channel:${Number(r.channel_id)}`,
    at: new Date(r.created_at).getTime(),
  }));
}
