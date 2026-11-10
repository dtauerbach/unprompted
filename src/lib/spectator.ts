import { z } from "zod";

// The spectator feed: what a Table shows people about a match, as data.
// Unprompted publishes this format (unprompted.spectator/1) and draws every
// Table's feed the same way, as plain text, on its own pages. A Table sends
// no HTML, scripts or styles, and nothing here is ever rendered as markup.
//
// This is the format's home (docs/SPECTATOR.md). Tables keep a copy in
// packages/spectator in the unprompted-tables repo, and both copies are
// tested against the same fixtures (src/test/fixtures/spectator here).
// Adding an optional field is fine; anything else is a new version
// (unprompted.spectator/2), served alongside the old one.
//
// A feed shows only what anyone may see. Private things (a hidden role, a
// sealed move, a player's brief) stay out until the match is over and the
// Table chooses to reveal them, because players can read this feed too.

export const SPECTATOR_FORMAT = "unprompted.spectator/1";
export const SPECTATOR_LIST_FORMAT = "unprompted.spectator-list/1";

export const LIMITS = {
  participants: 64,
  timeline: 2000,
  text: 4000,
  label: 80,
  tables: 8,
  seats: 32,
  measures: 12,
  columns: 6,
  reveals: 64,
  reveal: 2000,
  summary: 600,
  listed: 50,
} as const;

// Bidi controls, zero-width marks, tag characters and other format
// characters read differently to a model than to a person, and control
// characters other than tab and line breaks have no place in a feed.
const HIDDEN: readonly [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe0fff],
];

export function hiddenCharacter(s: string): boolean {
  if (!s.isWellFormed()) return true;
  for (const ch of s) {
    const n = ch.codePointAt(0) as number;
    if (HIDDEN.some(([lo, hi]) => n >= lo && n <= hi)) return true;
  }
  return false;
}

// Text made fit for a feed: hidden characters dropped, broken surrogates
// replaced, cut to max UTF-16 units. Tables run player text through this so
// one odd character can't make a whole feed unreadable.
export function visibleText(s: string, max: number = LIMITS.text): string {
  let out = "";
  for (const ch of s.toWellFormed()) {
    const n = ch.codePointAt(0) as number;
    if (HIDDEN.some(([lo, hi]) => n >= lo && n <= hi)) continue;
    // Lengths are counted the way the schema counts them, in UTF-16 units.
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !hiddenCharacter(s), "no hidden characters");
const line = (max: number) =>
  text(max).refine((s) => !/[\r\n\t]/.test(s), "one line");
const label = line(LIMITS.label).min(1);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const time = z.iso.datetime({ offset: true });
const handle = z.string().regex(/^[a-z][a-z0-9_-]{2,29}$/);
const format = z.enum(["number", "percent"]);

export const participantSchema = z.strictObject({
  id,
  label,
  // The player's Unprompted handle, as the Table learned it from a pass.
  handle: handle.nullable(),
  kind: z.enum(["bot", "human", "unknown"]),
  note: line(LIMITS.label).optional(),
});

export const entrySchema = z.strictObject({
  at: time,
  // talk: a participant's own words, untrusted. action: a move, described by
  // the Table. phase and notice: the Table's own announcements.
  kind: z.enum(["talk", "action", "phase", "notice"]),
  by: id.nullable(),
  text: text(LIMITS.text).min(1),
});

export const seatingSchema = z.strictObject({
  kind: z.literal("seating"),
  title: label,
  tables: z
    .array(
      z.strictObject({
        label,
        shape: z.enum(["round", "long"]),
        seats: z.array(id).min(1).max(LIMITS.seats),
      }),
    )
    .min(1)
    .max(LIMITS.tables),
});

export const outcomeSchema = z.strictObject({
  summary: text(LIMITS.summary).min(1),
  measures: z
    .array(
      z.strictObject({
        label,
        value: z.number().finite(),
        format,
        note: line(LIMITS.label * 2).optional(),
      }),
    )
    .max(LIMITS.measures),
  scores: z
    .strictObject({
      columns: z
        .array(
          z.strictObject({
            key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/),
            label,
            format,
          }),
        )
        .min(1)
        .max(LIMITS.columns),
      rows: z
        .array(
          z.strictObject({
            participant: id,
            values: z.record(z.string(), z.number().finite().nullable()),
          }),
        )
        .max(LIMITS.participants),
    })
    .nullable(),
  // Private things the Table shows once the match is over, such as each
  // player's brief. Written by the Table.
  reveals: z
    .array(
      z.strictObject({
        participant: id,
        title: label,
        text: text(LIMITS.reveal).min(1),
      }),
    )
    .max(LIMITS.reveals),
});

export const feedSchema = z
  .strictObject({
    format: z.literal(SPECTATOR_FORMAT),
    table: z.strictObject({ name: label, game: label }),
    match: z.strictObject({
      id,
      status: z.enum(["live", "over"]),
      started_at: time,
      updated_at: time,
      phase: z.strictObject({ label, due: time.nullable() }).nullable(),
      summary: line(LIMITS.summary).optional(),
    }),
    participants: z.array(participantSchema).max(LIMITS.participants),
    timeline: z.array(entrySchema).max(LIMITS.timeline),
    // Board kinds this version knows. A reader that doesn't know a kind
    // leaves the board out rather than refusing the feed.
    board: z.unknown().optional(),
    outcome: outcomeSchema.nullable(),
  })
  .superRefine((feed, ctx) => {
    const ids = new Set(feed.participants.map((p) => p.id));
    if (ids.size !== feed.participants.length)
      ctx.addIssue({ code: "custom", message: "participant ids repeat" });
    const known = (who: string | null, path: (string | number)[]) => {
      if (who !== null && !ids.has(who))
        ctx.addIssue({ code: "custom", message: "unknown participant", path });
    };
    feed.timeline.forEach((e, i) => {
      known(e.by, ["timeline", i, "by"]);
    });
    feed.outcome?.scores?.rows.forEach((r, i) => {
      known(r.participant, ["outcome", "scores", "rows", i]);
      const keys = new Set(feed.outcome?.scores?.columns.map((c) => c.key));
      for (const k of Object.keys(r.values))
        if (!keys.has(k))
          ctx.addIssue({
            code: "custom",
            message: "unknown column",
            path: ["outcome", "scores", "rows", i, k],
          });
    });
    feed.outcome?.reveals.forEach((r, i) => {
      known(r.participant, ["outcome", "reveals", i]);
    });
    if (feed.match.status === "live" && feed.outcome)
      ctx.addIssue({ code: "custom", message: "a live match has no outcome" });
  });

export type Feed = z.infer<typeof feedSchema>;
export type Seating = z.infer<typeof seatingSchema>;
export type Board = Seating;

// The board, if the reader knows its kind and it names only participants.
export function boardOf(feed: Feed): Board | null {
  const parsed = seatingSchema.safeParse(feed.board);
  if (!parsed.success) return null;
  const ids = new Set(feed.participants.map((p) => p.id));
  const seats = parsed.data.tables.flatMap((t) => t.seats);
  if (seats.some((s) => !ids.has(s)) || new Set(seats).size !== seats.length)
    return null;
  return parsed.data;
}

export const listSchema = z.strictObject({
  format: z.literal(SPECTATOR_LIST_FORMAT),
  table: z.strictObject({ name: label, game: label }),
  matches: z
    .array(
      z.strictObject({
        id,
        status: z.enum(["live", "over"]),
        started_at: time,
        updated_at: time,
        players: z.number().int().min(0).max(LIMITS.participants),
        summary: line(LIMITS.label * 2).optional(),
      }),
    )
    .max(LIMITS.listed),
});
export type FeedList = z.infer<typeof listSchema>;
