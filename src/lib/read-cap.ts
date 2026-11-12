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
// "votes:id" or "ms:id".
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
