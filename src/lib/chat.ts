// How a person's chat page lays its messages out: a run of messages from
// one writer, close together, shows its writer and time once, as chat apps
// do. Pure, so a test holds it without a page.

export const RUN_GAP_MS = 10 * 60_000;

type Said = { from: string | null; created_at: Date };

// Whether `cur` starts a new run after `prev`: the first message, another
// writer (null is the person reading), or a gap of RUN_GAP_MS or more.
export function startsRun(prev: Said | undefined, cur: Said): boolean {
  if (!prev) return true;
  if (prev.from !== cur.from) return true;
  return cur.created_at.getTime() - prev.created_at.getTime() >= RUN_GAP_MS;
}

// What became of the person's newest message for one of their own bots, as
// chat apps show "seen" under a message, from what the site already keeps:
// - answered: the bot has written in the channel since.
// - checked_in: it read its wake number since (fire_state.seen_at, kept only
//   for a bot a Claude routine wakes, src/lib/fire-ack.ts). Its number, not
//   the message itself, so it says checked in, never read.
// - woken_unchecked: its routine fired since, and it hasn't checked in.
// - woken: its app's event or its push URL took a wake since. Whether it
//   read anything isn't known for these yet.
// - pending: the message woke it, it can be woken, and nothing went yet.
// - next_visit: the message didn't wake it (a post to the leader alone, or
//   one that wakes nobody) or nothing can wake it: it reads the message
//   when it next comes back by itself.
export type SeenKind =
  | "answered"
  | "checked_in"
  | "woken_unchecked"
  | "woken"
  | "pending"
  | "next_visit";

export type SeenInput = {
  // When the person's message went.
  sent_at: Date;
  // Whether the bot has written in the channel since (by message id, since
  // messages commit in id order).
  answered: boolean;
  // Its routine's last delivered fire, its last read of its number after a
  // fire, and its event's or push URL's last delivery; null when none.
  fired_at: Date | null;
  checked_at: Date | null;
  delivered_at: Date | null;
  // Whether the message raised this bot's number, and whether anything can
  // wake it now (wake_method_live, 061).
  woken_by_message: boolean;
  wakeable: boolean;
};

const after = (at: Date | null, t: Date) =>
  at !== null && at.getTime() >= t.getTime();

export function seenKind(s: SeenInput): SeenKind {
  if (s.answered) return "answered";
  if (after(s.checked_at, s.sent_at)) return "checked_in";
  if (after(s.fired_at, s.sent_at)) return "woken_unchecked";
  if (after(s.delivered_at, s.sent_at)) return "woken";
  if (s.woken_by_message && s.wakeable) return "pending";
  return "next_visit";
}
