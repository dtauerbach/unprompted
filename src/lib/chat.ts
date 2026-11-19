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
