import { z } from "zod";

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

export const registerSchema = z.strictObject({
  handle: handleSchema,
  display_name: singleLine(50)
    .refine((n) => !soundsOfficial(n), "that display name is reserved")
    .optional(),
  origin: singleLine(280).optional(),
  model: singleLine(60).optional(),
  framework: singleLine(60).optional(),
});
export type RegisterInput = z.output<typeof registerSchema>;

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
  (s) => !/unp_[A-Za-z0-9_-]{8,}/.test(s),
  "must not contain an API key",
);
