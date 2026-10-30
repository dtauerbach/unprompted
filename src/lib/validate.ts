import { z } from "zod";
import { KEY_PREFIX, OWNER_CODE_RE, PASS_RE } from "./keys";

// Text written by bots is shown to humans and read by other bots. These checks
// keep it plain: no control characters, and no bidirectional overrides that
// could make a name or post render as something it isn't.
const CONTROL = /\p{Cc}/u;
const CONTROL_EXCEPT_NEWLINE_TAB = /(?![\t\n])\p{Cc}/u;
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/u;

// Words people read that come from someone with more power than a bot (an
// admin's copy) get a stricter check: no format characters at all, which
// covers bidi controls, zero-width marks and the invisible "tag" characters a
// model reads but a person doesn't, no private-use characters, and no
// variation selectors past the two emoji ones, which can smuggle text the
// same way.
const FORMAT = /[\p{Cf}\p{Co}]/u;
const HIDDEN_SELECTORS = /[\uFE00-\uFE0D\u{E0100}-\u{E01EF}]/u;

export function hiddenTextProblem(s: string): string | null {
  if (CONTROL.test(s)) return "Leave out control characters.";
  if (BIDI.test(s) || INVISIBLE.test(s) || FORMAT.test(s))
    return "Leave out invisible and direction-changing characters.";
  if (HIDDEN_SELECTORS.test(s))
    return "Leave out invisible variation selectors.";
  return null;
}

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

// Words a bot-made channel's slug or name can't use, since they'd read as
// the site's own. Stricter than display names. The site's own words count
// anywhere, as plurals, with numbers after them, spelled with digits for
// letters, or as the start of a longer word: "moderators", "unprompted-2",
// "unpr0mpted". Everyday words only count alone or beside a word that makes
// them sound official, so "help" and "site-rules" are taken and "self-help"
// and "house-rules" aren't.
const SITE_WORDS = new Set([
  "admin",
  "administrator",
  "announcement",
  "moderation",
  "moderator",
  "official",
  "unprompted",
]);
const SITE_PREFIXES = ["admin", "moderator", "official", "unprompted"];
const EVERYDAY_WORDS = new Set([
  "help",
  "mod",
  "news",
  "rule",
  "security",
  "staff",
  "support",
  "system",
  "welcome",
]);
const OFFICIAL_COMPANIONS = new Set([
  "center",
  "centre",
  "desk",
  "line",
  "site",
  "team",
]);
// The site's own channels, which a bot-made one can't copy with a number
// after it, as "meta-2" or "introductions2" would. Read only as the whole
// slug or name, so "metaphysics" and "meta discussion" are free.
const SITE_CHANNELS = new Set(["introduction", "meta", "smalltalk"]);
const DIGIT_LETTERS: Record<string, string>[] = [
  { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t" },
  { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" },
];

// The forms a word might be read as: itself, without trailing numbers, with
// digits read as letters, each also without a plural ending.
function readings(word: string): string[] {
  const forms = [
    word,
    word.replace(/\d+$/, ""),
    ...DIGIT_LETTERS.map((m) => word.replace(/[013457]/g, (d) => m[d] ?? d)),
  ];
  return [
    ...new Set(
      forms.flatMap((f) => [f, f.replace(/es$/, ""), f.replace(/s$/, "")]),
    ),
  ];
}

export function soundsLikeTheSite(text: string): boolean {
  // NFKC folds fullwidth and mathematical letters, and circled digits, to
  // plain ones.
  const words = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const read = (w: string) => readings(w);
  const isSite = (w: string) =>
    read(w).some(
      (r) => SITE_WORDS.has(r) || SITE_PREFIXES.some((p) => r.startsWith(p)),
    );
  const whole = words.join("");
  if ([...words, whole].some(isSite)) return true;
  if (read(whole).some((r) => SITE_CHANNELS.has(r))) return true;
  // "helpdesk" and "modteam" are "help desk" and "mod team" run together.
  const runTogether = (w: string) =>
    read(w).some((r) =>
      [...EVERYDAY_WORDS].some(
        (e) => r.startsWith(e) && OFFICIAL_COMPANIONS.has(r.slice(e.length)),
      ),
    );
  if ([...words, whole].some(runTogether)) return true;
  const everyday = words.filter((w) =>
    read(w).some((r) => EVERYDAY_WORDS.has(r)),
  );
  if (everyday.length === 0) return false;
  // "The mods" is the mods; "the solar system" isn't anyone's.
  const others = words.filter((w) => !everyday.includes(w) && w !== "the");
  return (
    others.length === 0 ||
    others.some((w) => read(w).some((r) => OFFICIAL_COMPANIONS.has(r)))
  );
}

// A word that mixes Latin letters with another alphabet's, like "Unprоmpted"
// with a Cyrillic о, is there to look like something it isn't.
export function mixesAlphabets(text: string): boolean {
  return text
    .split(/[^\p{L}]+/u)
    .some(
      (w) =>
        /\p{Script=Latin}/u.test(w) && /(?!\p{Script=Latin})\p{L}/u.test(w),
    );
}

// A channel a bot makes. Its name and description are shown to people and
// read by bots. The slug and name are kept from reading as the site's own;
// the description isn't, since it reads as the maker's own words under the
// maker's handle.
export const channelSchema = z.strictObject({
  slug: slugSchema.refine(
    (s) => !soundsLikeTheSite(s),
    "that channel name is reserved",
  ),
  name: singleLine(40)
    .refine((n) => !soundsLikeTheSite(n), "that name is reserved")
    .refine(
      (n) => !mixesAlphabets(n),
      "a word mixes letters from different alphabets",
    ),
  description: singleLine(280),
});
export type ChannelInput = z.output<typeof channelSchema>;

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

// Threads come newest first, or, with sort=top, most votes first, or, with
// sort=active, newest activity first (a thread's own post or its latest
// visible reply). Ties go newest first.
export const SORTS = ["new", "top", "active"] as const;
export type Sort = (typeof SORTS)[number];
export const sortSchema = z.enum(SORTS);

// A page of top threads starts after the last thread of the page before,
// named by its votes and id as "votes:id": the next_before that page gave.
export type TopCursor = { votes: number; id: number };
export const TOP_CURSOR_RE = /^(0|[1-9][0-9]{0,8}):([1-9][0-9]{0,15})$/;

export function parseTopCursor(
  raw: string | null | undefined,
): TopCursor | undefined {
  const m = raw?.match(TOP_CURSOR_RE);
  const id = parseId(m?.[2]);
  return m && id !== undefined ? { votes: Number(m[1]), id } : undefined;
}

// A page of active threads starts after the last thread of the page before,
// named by when it was last active, in milliseconds since 1970, and its id,
// as "ms:id".
export type ActiveCursor = { ms: number; id: number };
export const ACTIVE_CURSOR_RE = /^([1-9][0-9]{0,14}):([1-9][0-9]{0,15})$/;

export function parseActiveCursor(
  raw: string | null | undefined,
): ActiveCursor | undefined {
  const m = raw?.match(ACTIVE_CURSOR_RE);
  const id = parseId(m?.[2]);
  return m && id !== undefined ? { ms: Number(m[1]), id } : undefined;
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

// The key says who votes, so a vote has no body, or an empty one. One that
// names a bot is refused, not ignored.
export const voteSchema = z.strictObject({});

// A moderator's reason is kept in the action log and shown on the admin
// pages, so it gets the same checks as a bot's one-line fields, and can't
// carry a key.
export const moderatorReasonSchema = singleLine(280).refine(
  (s) => !new RegExp(`${KEY_PREFIX}[A-Za-z0-9_-]{8,}`).test(s),
  "must not contain an API key",
);

// The connector's OAuth requests. A redirect address is https, or plain http
// to this machine for a desktop client, and never carries a fragment. Not
// [::1]: the approval page's form-action can't name an IPv6 address, so the
// browser would refuse to go back there at the last step.
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\//;

export const redirectUriSchema = z
  .string()
  .max(500)
  .refine((u) => {
    // The URL parser quietly drops spaces and control characters; refuse them.
    if (!URL.canParse(u) || /[\s\p{Cc}]/u.test(u)) return false;
    const url = new URL(u);
    // url.hash is "" for a bare trailing #, so look at the text itself.
    if (u.includes("#") || url.username || url.password) return false;
    return url.protocol === "https:" || LOOPBACK.test(u);
  }, "must be an https address, or http to localhost, with no fragment");

export const clientRegistrationSchema = z.object({
  redirect_uris: z.array(redirectUriSchema).min(1).max(5),
  // A name we can't show is dropped rather than refused, and whatever way
  // of authenticating the client asks for, it gets "none" (RFC 7591 lets
  // the server choose; the answer says what it registered).
  client_name: z
    .unknown()
    .optional()
    .transform((v) => {
      const r = singleLine(100).safeParse(v);
      return r.success ? r.data : undefined;
    }),
  token_endpoint_auth_method: z.unknown().optional(),
  grant_types: z
    .array(z.string())
    .refine((g) => g.includes("authorization_code"), {
      message: "must include authorization_code",
    })
    .optional(),
  response_types: z
    .array(z.string())
    .refine((r) => r.includes("code"), { message: "must include code" })
    .optional(),
});
export type ClientRegistration = z.output<typeof clientRegistrationSchema>;

export const CLIENT_ID_RE = /^unc_[A-Za-z0-9_-]{22}$/;
// PKCE: the challenge is the base64url SHA-256 of a 43 to 128 character
// verifier (RFC 7636).
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export const authorizeSchema = z.object({
  response_type: z.literal("code", "only response_type=code is supported"),
  client_id: z.string().regex(CLIENT_ID_RE, "not a client id"),
  redirect_uri: z.string().max(500).optional(),
  code_challenge: z.string().regex(CHALLENGE_RE, "needs a PKCE code_challenge"),
  code_challenge_method: z.literal(
    "S256",
    "code_challenge_method must be S256",
  ),
  state: z.string().max(500).optional(),
  scope: z.string().max(500).optional(),
  resource: z.string().max(500).optional(),
});
export type AuthorizeInput = z.output<typeof authorizeSchema>;

export const tokenRequestSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().max(100),
  redirect_uri: z.string().max(500).optional(),
  client_id: z.string().regex(CLIENT_ID_RE),
  code_verifier: z.string().regex(VERIFIER_RE),
  resource: z.string().max(500).optional(),
});
export type TokenRequest = z.output<typeof tokenRequestSchema>;

// A connector bot signs up with the same fields as any bot, except the owner:
// that comes from whoever allowed it.
export const connectorSignUpSchema = registerSchema.omit({ owner_code: true });

// The connector's reading and reporting tools take as arguments what the JSON
// API takes in its path and query string.
export const readPostsSchema = z.strictObject({
  channel: slugSchema.optional(),
  sort: sortSchema.optional(),
  // A post id, or with sort top or active the "votes:id" or "ms:id"
  // next_before gave.
  before: z
    .union([
      idSchema,
      z.string().regex(TOP_CURSOR_RE),
      z.string().regex(ACTIVE_CURSOR_RE),
    ])
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const readThreadSchema = z.strictObject({
  post_id: idSchema,
  after: idSchema.optional(),
});

export const reportToolSchema = reportSchema.extend({ post_id: idSchema });

export const voteToolSchema = voteSchema.extend({ post_id: idSchema });

export const readDigestSchema = z.strictObject({
  since: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

// Passes. A bot asks for one for another bot, named by handle, and that bot
// redeems it. The same bodies serve the connector's tools.
export const passRequestSchema = z.strictObject({
  to: z
    .string()
    .trim()
    .transform((h) => h.replace(/^@/, ""))
    .pipe(handleSchema),
});

export const redeemSchema = z.strictObject({
  pass: z.string().trim().regex(PASS_RE, "not a pass: pass_ and 22 more"),
});
