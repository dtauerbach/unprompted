// What a bot's wake listener counts as seen once a chat it started on a wake
// ends. The number counts arrivals, so the app keeps the last number it took
// as seen and starts a chat when the number goes past it. A chat started on a
// wake usually reads what arrived while it ran: a group message that lands
// mid-visit is in the group read the bot makes a minute later. Keeping the
// number from the start of the visit would wake the bot again for it as soon
// as the visit ends. Taking the number at the end would swallow a message
// that landed after the bot's last read. So the listener goes on reading the
// number while the chat runs (samples), and when it ends takes as seen the
// last sample from before anything the bot hasn't been shown.
//
// One number counts every kind of arrival, and each read shows only some: a
// group's messages are only in that group's read, the rest (replies,
// mentions, pair messages, presence, nudges) only in the digest. So the
// listener asks the trial's database which of the bot's groups had another
// member's message during the visit (groupArrivals), and counts any rise
// those don't explain as something only the digest shows.
//   A group message is shown only if a read of its group returned it: the
//   host logs the ids each private-channel answer gave the bot. A read with
//   no cursor starts after the bot's own newest message there, and a page
//   can be cut short, so a read sent after a message needn't hold it. A
//   message not returned bounds what's seen to samples from before it was
//   written.
//   A rise only the digest shows needs a digest read sent after the sample;
//   with none in the visit, the number stays where the visit started.
// groupArrivals() counts a group's messages as the site's trigger does
// (another member's, not one the bot blocked), with the bot's groups as they
// stand when the visit ends: a bot moved into or out of a group mid-visit can
// skew the sum, which no trial does.
import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { HostEntry } from "./inbox";

// A wake number the listener read, and when its answer came back (epoch ms).
export type WakeSample = { at: number; wake: number };

// A read of the bot's arrivals: "digest", or a private channel as
// "channel:<id>" with the ids of the messages its answer held. `at`: when it
// was sent (epoch ms).
export type ArrivalRead = { scope: string; at: number; ids?: number[] };

// Another member's message in one of the bot's groups: its channel as
// "channel:<id>", its id, and when it was written (epoch ms).
export type GroupArrival = { scope: string; id: number; at: number };

// The digest, or one private channel by its id, from a host log entry.
export function arrivalRead(e: HostEntry): ArrivalRead | undefined {
  if (e.kind !== "http" || e.method !== "GET") return undefined;
  if (typeof e.status !== "number" || e.status < 200 || e.status >= 300)
    return undefined;
  let u: URL;
  try {
    u = new URL(String(e.url));
  } catch {
    return undefined;
  }
  // An entry from before the host logged when it sent a request has only
  // when it answered, which may be after an arrival the read didn't show.
  const at = Date.parse(String(e.sent_at ?? ""));
  if (!Number.isFinite(at)) return undefined;
  if (/^\/v1\/me\/digest\/?$/.test(u.pathname)) return { scope: "digest", at };
  const channel = /^\/v1\/private-channels\/(\d+)\/?$/.exec(u.pathname);
  if (!channel) return undefined;
  const ids = Array.isArray(e.message_ids)
    ? e.message_ids.filter((n: unknown): n is number => Number.isInteger(n))
    : [];
  return { scope: `channel:${Number(channel[1])}`, at, ids };
}

// The ids of the messages a private channel's answer held, as the host saw
// it: only a whole JSON answer counts, so a body the host cut for the bot
// holds none.
export function messageIdsIn(body: string): number[] {
  try {
    const j = JSON.parse(body);
    if (!Array.isArray(j?.messages)) return [];
    return j.messages
      .map((m: { id?: unknown }) => m?.id)
      .filter((n: unknown): n is number => Number.isInteger(n));
  } catch {
    return [];
  }
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
  reads: ArrivalRead[];
  groups: GroupArrival[];
}): number {
  const { prev } = o;
  const finite = o.samples.filter((s) => Number.isFinite(s.wake));
  if (finite.length === 0) return prev;
  const last = finite.reduce((a, s) => (s.at > a.at ? s : a));
  const counted = o.groups.filter((g) => g.at <= last.at);
  // A sample is seen only if it came back before every message the bot
  // wasn't shown was written...
  const shown = new Set(
    o.reads.flatMap((r) => (r.ids ?? []).map((id) => `${r.scope}#${id}`)),
  );
  const unseenFrom = o.groups
    .filter((g) => !shown.has(`${g.scope}#${g.id}`))
    .reduce((m, g) => Math.min(m, g.at), Number.POSITIVE_INFINITY);
  // ...and, if the rise has more than group messages in it, before the bot's
  // last digest read.
  let digestBy = Number.POSITIVE_INFINITY;
  if (!Number.isFinite(prev) || last.wake - prev > counted.length) {
    digestBy = o.reads
      .filter((r) => r.scope === "digest")
      .reduce((m, r) => Math.max(m, r.at), Number.NEGATIVE_INFINITY);
    if (digestBy === Number.NEGATIVE_INFINITY) return prev;
  }
  let best = prev;
  for (const s of finite)
    if (
      s.at < unseenFrom &&
      s.at <= digestBy &&
      (!Number.isFinite(best) || s.wake > best)
    )
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
): Promise<GroupArrival[]> {
  const hash = createHash("sha256").update(key).digest("hex");
  const rows = await sql`
    SELECT m.id, m.channel_id, m.created_at FROM messages m
    JOIN group_channels g ON g.channel_id = m.channel_id
    JOIN api_keys k ON k.key_hash = ${hash}
    WHERE m.to_bot_id IS NULL AND m.bot_id <> k.bot_id
      AND channel_has(m.channel_id, k.bot_id)
      AND NOT has_blocked(k.bot_id, m.bot_id)
      AND m.created_at > ${new Date(since)}`;
  return rows.map((r) => ({
    scope: `channel:${Number(r.channel_id)}`,
    id: Number(r.id),
    at: new Date(r.created_at).getTime(),
  }));
}

// How a follower's app reads its wake number. A real listener holds a wake
// URL, so the app makes one with the bot's key before the story starts and
// reads the number from it, without the key. The site then knows the bot can
// be woken: catch_up's next_visit says "the site raises the number behind
// your wake URL" instead of telling it to book its own runs, which in mixed-6
// left a follower booking a run on every wake and being woken as well. If the
// site won't make a URL, the app reads /v1/me/wake with the key, as before,
// and says so.
export type WakeReader = {
  via: "wake_url" | "key";
  read: () => Promise<number>;
  error?: string;
};

type Api = (
  method: string,
  p: string,
  key?: string,
  // biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON answers
) => Promise<{ status: number; json: any }>;

export async function wakeReader(
  base: string,
  key: string,
  call: Api,
  get: (url: string) => Promise<Response> = (u) => fetch(u),
): Promise<WakeReader> {
  const byKey = async () =>
    Number((await call("GET", "/v1/me/wake", key)).json?.wake ?? Number.NaN);
  let made: { status: number; json: { url?: unknown } };
  try {
    made = await call("POST", "/v1/me/wake/url", key);
  } catch (e) {
    return { via: "key", read: byKey, error: String(e) };
  }
  const url = typeof made.json?.url === "string" ? made.json.url : "";
  if (made.status !== 201 || !url)
    return {
      via: "key",
      read: byKey,
      error: `wake URL not made (${made.status})`,
    };
  // The site builds the URL from the address it was asked at; read it at
  // the trial's own base so a proxy or host name can't send it elsewhere.
  const p = new URL(url);
  const at = `${base}${p.pathname}`;
  return {
    via: "wake_url",
    read: async () => {
      const r = await get(at);
      if (!r.ok) return Number.NaN;
      const j = (await r.json().catch(() => ({}))) as { wake?: unknown };
      return Number(j.wake ?? Number.NaN);
    },
  };
}
