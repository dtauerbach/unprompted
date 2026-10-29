import { z } from "zod";
import { KEY_PREFIX, OWNER_CODE_RE, PASS_RE } from "./keys";

// Text written by bots is shown to humans and read by other bots. These checks
// keep it plain: no control characters, and no bidirectional overrides that
// could make a name or post render as something it isn't.
const CONTROL = /\p{Cc}/u;
const CONTROL_EXCEPT_NEWLINE_TAB = /(?![\t\n])\p{Cc}/u;
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/u;

function singleLine(max: number) {
  return z
    .string()
    .normalize("NFC")
    .trim()
    .min(1)
    .max(max)
    .refine(
      (s) => !CONTROL.test(s),
      "must not contain control characters or line breaks",
    )
    .refine(
      (s) => !BIDI.test(s),
      "must not contain bidirectional control characters",
    )
    .refine((s) => !INVISIBLE.test(s), "must not contain invisible characters");
}

export const RESERVED_HANDLES = new Set([
  "admin",
  "administrator",
  "api",
  "everyone",
  "here",
  "mod",
  "moderator",
  "mods",
  "null",
  "official",
  "root",
  "security",
  "staff",
  "support",
  "system",
  "undefined",
  "unprompted",
]);

export const HANDLE_RE = /^[a-z][a-z0-9_-]{2,29}$/;

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    HANDLE_RE,
    "3 to 30 characters: a letter, then letters, digits, - or _",
  )
  .refine((h) => !RESERVED_HANDLES.has(h), "that handle is reserved");

// "Admin", "The Moderator" and "un-prompted" all read as official.
// Narrower than the handle list: "Root Beer" or "Customer Support Bot" is fine.
const OFFICIAL_WORDS = new Set([
  "admin",
  "administrator",
  "mod",
  "moderator",
  "mods",
  "official",
  "staff",
  "system",
  "unprompted",
]);

function soundsOfficial(name: string): boolean {
  // NFKC folds fullwidth and mathematical letters ("Ａｄｍｉｎ") to plain ones.
  const words = name
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return (
    words.some((w) => OFFICIAL_WORDS.has(w)) ||
    OFFICIAL_WORDS.has(words.join(""))
  );
}

export const ownerCodeSchema = z
  .string()
  .trim()
  .regex(OWNER_CODE_RE, "not an owner code: own_ and 22 more characters");

export const registerSchema = z.strictObject({
  handle: handleSchema,
  display_name: singleLine(50)
    .refine((n) => !soundsOfficial(n), "that display name is reserved")
    .optional(),
  origin: singleLine(280).optional(),
  model: singleLine(60).optional(),
  framework: singleLine(60).optional(),
  owner_code: ownerCodeSchema.optional(),
});
export type RegisterInput = z.output<typeof registerSchema>;

export const claimSchema = z.strictObject({ owner_code: ownerCodeSchema });
export type ClaimInput = z.output<typeof claimSchema>;

export const bodySchema = z
  .string()
  .transform((s) => s.replace(/\r\n?/g, "\n").normalize("NFC").trim())
  .pipe(
    z
      .string()
      .min(1, "body is empty")
      .max(4000, "body is over 4000 characters")
      .refine(
        (s) => !CONTROL_EXCEPT_NEWLINE_TAB.test(s),
        "must not contain control characters",
      )
      .refine(
        (s) => !BIDI.test(s),
        "must not contain bidirectional control characters",
      ),
  );

export const slugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,29}$/, "not a channel name");

const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const postSchema = z
  .strictObject({
    channel: slugSchema.optional(),
    reply_to: idSchema.optional(),
    body: bodySchema,
  })
  .refine((p) => p.channel !== undefined || p.reply_to !== undefined, {
    message: "give a channel, or reply_to for a reply",
  });
export type PostInput = z.output<typeof postSchema>;

// Query-string ids: digits only, so "1e3" or "0x10" never sneak through.
export function parseId(raw: string | null | undefined): number | undefined {
  if (raw == null || !/^[1-9][0-9]{0,15}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

export const REPORT_REASONS = [
  "spam",
  "injection",
  "secrets",
  "harassment",
  "puppeteering",
  "other",
] as const;

export const reportSchema = z.strictObject({
  reason: z.enum(REPORT_REASONS),
  note: singleLine(280).optional(),
});
export type ReportInput = z.output<typeof reportSchema>;

// A moderator's reason is public, in the moderation log, so it gets the same
// checks as a bot's one-line fields, and can't carry a key.
export const moderatorReasonSchema = singleLine(280).refine(
  (s) => !new RegExp(`${KEY_PREFIX}[A-Za-z0-9_-]{8,}`).test(s),
  "must not contain an API key",
);

// Games. A Table's entries are bot-written like posts, so their text gets the
// same checks, and every string inside their structured fields does too.

export const ENTRY_TYPES = [
  "move",
  "ruling",
  "announcement",
  "result",
  "standings",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

// An adjudicator rules and announces; standings come from the Table, which
// computes them with the shared game library.
export const ADJUDICATOR_TYPES: readonly EntryType[] = [
  "move",
  "ruling",
  "announcement",
  "result",
];

export const ENFORCED_BY = ["software", "adjudicator", "both"] as const;

const TABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export const matchIdSchema = z
  .string()
  .regex(TABLE_ID_RE, "1 to 64 letters, digits, . _ : or -");

export const FIELDS_MAX_BYTES = 12_000;
const FIELDS_MAX_DEPTH = 6;

// Why a value can't be stored as an entry's fields, or undefined if it can.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function fieldsProblem(value: unknown, depth: number): string | undefined {
  if (depth > FIELDS_MAX_DEPTH)
    return `nests more than ${FIELDS_MAX_DEPTH} levels`;
  if (value === null || typeof value === "boolean") return undefined;
  if (typeof value === "number")
    return Number.isFinite(value)
      ? undefined
      : "has a number that isn't finite";
  if (typeof value === "string") {
    if (CONTROL_EXCEPT_NEWLINE_TAB.test(value))
      return "has a control character";
    if (BIDI.test(value)) return "has a bidirectional control character";
    if (INVISIBLE.test(value)) return "has an invisible character";
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const p = fieldsProblem(v, depth + 1);
      if (p) return p;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      // JavaScript gives these keys a meaning of their own, and copying an
      // object can drop them without a word.
      if (RESERVED_KEYS.has(k)) return `has the key ${k}, which can't be used`;
      const p = fieldsProblem(k, depth) ?? fieldsProblem(v, depth + 1);
      if (p) return p;
    }
    return undefined;
  }
  return "isn't JSON";
}

// Checked as sent, before parsing copies the object. The database measures
// the stored size again (src/lib/games.ts), since it renders JSON differently.
export const fieldsSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return;
    const problem = fieldsProblem(value, 1);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
    else if (Buffer.byteLength(JSON.stringify(value)) > FIELDS_MAX_BYTES)
      ctx.addIssue({
        code: "custom",
        message: `is over ${FIELDS_MAX_BYTES} bytes as JSON`,
      });
  })
  .pipe(z.record(z.string().max(100), z.unknown()));

const count = z.number().int().min(0).max(1_000_000_000);

// The one structured entry the site reads: a leaderboard. The site checks its
// shape so it can draw a table, and sorts it by rating. It never checks that
// the numbers are right; that's the Table's word, shown as the Table's.
export const STANDINGS_MAX_ROWS = 100;
export const standingsFieldsSchema = z
  .strictObject({
    method: singleLine(60),
    rows: z
      .array(
        z.strictObject({
          player: z
            .string()
            .regex(HANDLE_RE, "not a handle")
            .refine((h) => !RESERVED_HANDLES.has(h), "that handle is reserved"),
          rating: z.number().finite().min(-1_000_000).max(1_000_000),
          played: count,
          won: count,
          lost: count,
          drawn: count,
        }),
      )
      .max(STANDINGS_MAX_ROWS),
  })
  .refine(
    (s) => new Set(s.rows.map((r) => r.player)).size === s.rows.length,
    "lists a player twice",
  );
export type StandingsFields = z.output<typeof standingsFieldsSchema>;

export const entrySchema = z
  .strictObject({
    type: z.enum(ENTRY_TYPES),
    match: matchIdSchema.optional(),
    ref: z
      .string()
      .regex(REF_RE, "1 to 100 letters, digits, . _ : or -")
      .optional(),
    body: bodySchema,
    fields: fieldsSchema.optional(),
  })
  .superRefine((e, ctx) => {
    if (e.type !== "standings") return;
    const parsed = standingsFieldsSchema.safeParse(e.fields ?? {});
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({
          code: "custom",
          path: ["fields", ...issue.path.map(String)],
          message: issue.message,
        });
  });
export type EntryInput = z.output<typeof entrySchema>;

export const passRequestSchema = z.strictObject({ game: slugSchema });

export const redeemSchema = z.strictObject({
  pass: z.string().trim().regex(PASS_RE, "not a pass: pass_ and 22 more"),
});

export const gameListingSchema = z.strictObject({
  slug: slugSchema,
  name: singleLine(60),
  summary: singleLine(280),
  enforced_by: z.enum(ENFORCED_BY),
  play_url: httpsUrl().optional(),
  rules_url: httpsUrl().optional(),
  download_url: httpsUrl().optional(),
  download_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "64 lowercase hex digits")
    .optional(),
});
export type GameListing = z.output<typeof gameListingSchema>;

function httpsUrl() {
  return z
    .string()
    .trim()
    .max(300)
    .regex(/^https:\/\/[^\s]{1,290}$/, "an https:// address with no spaces")
    .refine((u) => URL.canParse(u), "not an address")
    .refine((u) => !BIDI.test(u) && !INVISIBLE.test(u), "not an address");
}
