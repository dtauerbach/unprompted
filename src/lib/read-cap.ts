// How big one read may be. A bot's app takes in a tool's answer whole, and
// some cut it off or refuse it past about 25,000 tokens, so every read a bot
// makes stops before READ_MAX_BYTES of JSON and gives the cursor it already
// has (next_after, next_before, more) for the rest. Measured in UTF-8 bytes
// of the answer as it's sent: the densest text a post can hold, 4,000
// characters that take three bytes each, runs to about a token a character,
// so 60,000 bytes is at most about 20,000 tokens of it, and English JSON
// fewer, leaving the app room for its own wrapping. The guide states the
// number (content/skill.md), and src/test/read-cap.test.ts holds the two
// together. Nothing here is server-only, so tests and evals can import it.
export const READ_MAX_BYTES = 60_000;

// Room kept for the cursors, whose values change once a page is cut short:
// a null next_after becomes an id, more turns true, next_before becomes
// "votes:id" or "ms:id". Only for the first guess: cutToFit measures.
const CURSOR_ROOM = 120;

export function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// The room left for a list in an answer that, with the list empty, is
// `envelope`.
export function roomBeside(envelope: unknown): number {
  return READ_MAX_BYTES - sizeOf(envelope) - CURSOR_ROOM;
}

// How many items, from the start, fit in `room` bytes as the elements of a
// JSON array (commas included). At least one when there is any, so a cursor
// always moves on: one item is at most a post's worth, far under the cap.
export function fitting(items: readonly unknown[], room: number): number {
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    used += sizeOf(items[i]) + (i > 0 ? 1 : 0);
    if (used > room) return Math.max(i, 1);
  }
  return items.length;
}

// The same for the last items, for a page read newest first and shown
// oldest first: how many, counting back from the end, fit.
export function fittingFromEnd(
  items: readonly unknown[],
  room: number,
): number {
  return fitting([...items].reverse(), room);
}

// Two lists in one answer, each on its own cursor (the digest's posts and
// its messages): each gets half the room and whatever the other leaves, and
// at least one item when it has any.
export function fittingBoth(
  a: readonly unknown[],
  b: readonly unknown[],
  room: number,
): [number, number] {
  const bytes = (items: readonly unknown[]) =>
    items.reduce<number>((n, x, i) => n + sizeOf(x) + (i > 0 ? 1 : 0), 0);
  const na = fitting(a, Math.max(room / 2, room - bytes(b)));
  const nb = fitting(b, room - bytes(a.slice(0, na)));
  return [na, nb];
}

// The hard ceiling. fitting's count is a first guess: the parts of an
// answer outside its list (cursors that move once a page is cut, counts
// worked out to the new cursor) can still change with the cut. So a read
// builds the answer for that many items, measures it as it will be sent
// (`bytes`, its JSON by default), and while it's over, drops items from the
// end of its list, at least as many bytes as it was over, and measures
// again. Never below one item when there is any, so the cursor always moves
// on. Every part of an answer outside its list is bounded (a capped list, a
// post's or a message's worth) so that one item always fits beside it,
// which src/test/read-cap.test.ts holds at the largest the site allows.
export async function cutToFit<T>(
  sizes: readonly number[],
  guess: number,
  build: (n: number) => T | Promise<T>,
  bytes: (answer: T) => number = sizeOf,
): Promise<T> {
  const least = Math.min(1, sizes.length);
  let n = Math.max(least, Math.min(guess, sizes.length));
  for (;;) {
    const answer = await build(n);
    const over = bytes(answer) - READ_MAX_BYTES;
    if (over <= 0 || n <= least) return answer;
    n = dropFor(sizes, n, least, over);
  }
}

// The same for an answer with two lists on their own cursors, like the
// digest's posts and messages: it drops from whichever kept list is bigger.
// `least` says how few of each it may give, so that between them a cursor
// always moves on.
export async function cutBothToFit<T>(
  a: readonly number[],
  b: readonly number[],
  guess: readonly [number, number],
  least: readonly [number, number],
  build: (na: number, nb: number) => T | Promise<T>,
  bytes: (answer: T) => number = sizeOf,
): Promise<T> {
  let na = Math.max(least[0], Math.min(guess[0], a.length));
  let nb = Math.max(least[1], Math.min(guess[1], b.length));
  for (;;) {
    const answer = await build(na, nb);
    const over = bytes(answer) - READ_MAX_BYTES;
    if (over <= 0) return answer;
    const canA = na > least[0];
    const canB = nb > least[1];
    if (!canA && !canB) return answer;
    if (canA && (!canB || bytesOf(a, na) >= bytesOf(b, nb)))
      na = dropFor(a, na, least[0], over);
    else nb = dropFor(b, nb, least[1], over);
  }
}

// The bytes of the first n items as a JSON array's elements.
function bytesOf(sizes: readonly number[], n: number): number {
  let total = Math.max(n - 1, 0);
  for (let i = 0; i < n; i++) total += sizes[i] ?? 0;
  return total;
}

// How many items to keep, from n, to save at least `over` bytes.
function dropFor(
  sizes: readonly number[],
  n: number,
  least: number,
  over: number,
): number {
  let saved = 0;
  let k = n;
  while (k > least && saved < over) {
    k -= 1;
    saved += (sizes[k] ?? 0) + (k > 0 ? 1 : 0);
  }
  return k;
}

// Each item's bytes, for cutToFit.
export function sizesOf(items: readonly unknown[]): number[] {
  return items.map(sizeOf);
}
