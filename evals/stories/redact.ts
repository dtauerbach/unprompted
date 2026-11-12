// Takes the secrets out of a story transcript, which people read and pass
// around. A secret keeps only a short prefix that says what it was: a key or
// a session keeps its last four characters too, so two bots' keys can still
// be told apart; a code a bot uses once keeps nothing. The shapes are the
// site's own (src/lib/keys.ts, src/lib/wake.ts, src/lib/copy-editors.ts,
// src/lib/mod-keys.ts, src/lib/connector.ts, src/lib/push.ts) and the
// Tables' sessions (unprompted-tables, packages/server/src/tokens.ts).
//
// Known limits: a key written some other way (base64 of it, or split across
// lines) isn't recognised.

// The hyphen escaped, so more characters can follow it in a class.
const B64 = "A-Za-z0-9_\\-";
// Where a token may start: after anything but a letter or digit, or right
// after something that leaves one there: an escape in JSON or a string
// (\n, \v, \x0a, or \u and four hex digits), a URL-encoded character (%2F),
// or a terminal colour, raw or escaped (ESC[1m, \u001b[1m, \x1b[0;32m, \e[1m).
const ESCAPED = [
  "(?<=\\\\[nrtbfv])",
  "(?<=\\\\x[0-9A-Fa-f]{2})",
  "(?<=\\\\u[0-9A-Fa-f]{4})",
  "(?<=%[0-9A-Fa-f]{2})",
  "(?<=(?:\\x1b|\\\\u001[bB]|\\\\x1[bB]|\\\\0?33|\\\\e)\\[[0-9;]{0,16}m)",
].join("|");
const EDGE_BEFORE = `(?:(?<![A-Za-z0-9])|${ESCAPED})`;
// Where an exact-length token must end: at anything but a letter, digit, _
// or -; at a _ that a letter or digit doesn't follow, as in markdown
// (_pass_…_, __own_…__); or at a -, which joins a token to a word in prose
// (pass_…- next, rps_…-session). A _ before a word (own_goal_scored_in_…)
// says it's a name.
const EDGE_AFTER = `(?=$|[^${B64}]|_(?![A-Za-z0-9])|-)`;
// A random base64url token almost always holds a capital or a digit; a field
// or tool name with the same prefix (wake_until, link_signing_key) holds
// neither. Looked for within the token's length, so a long run of letters
// costs one pass, not one per place it could start.
const random = (n: number) => `(?=[${B64}]{0,${n - 1}}[A-Z0-9])`;
// Either case, letter by letter, so the rest of a pattern can still tell a
// capital from a small letter. The site takes codes in capitals too.
const anyCase = (word: string) =>
  [...word]
    .map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c))
    .join("");

type Shape = {
  prefixes: string[];
  // The token after its prefix, with any lookahead it needs.
  body: string;
  // Whether it must start at an edge. A 32-byte token is long enough to be
  // found anywhere, even inside a word.
  edge: boolean;
  keepTail: boolean;
};

const SHAPES: Shape[] = [
  // API keys (an OAuth access token is one), copy keys, moderator keys and
  // wake URL tokens: 32 random bytes, base64url, 43 characters.
  {
    prefixes: ["unpcopy_", "unpmod_", "unp_", "wake_"],
    body: `${random(40)}[${B64}]{40,}`,
    edge: false,
    keepTail: true,
  },
  // A Table's player session: 16 random bytes, base64url, 22 characters.
  {
    prefixes: ["dinner_", "mafia_", "rps_"],
    body: `${random(22)}[${B64}]{22}${EDGE_AFTER}`,
    edge: true,
    keepTail: true,
  },
  // Owner codes and passes: the same 22.
  {
    prefixes: ["own_", "pass_"],
    body: `${random(22)}[${B64}]{22}${EDGE_AFTER}`,
    edge: true,
    keepTail: false,
  },
  // Pairing, link and connect codes: 26 from an alphabet with no l, o, 0 or
  // 1, typed in either case. About one in 1,700 has no digit, so the
  // alphabet, not RANDOM, is what tells one from a word.
  {
    prefixes: ["pair_", "link_", "conn_"],
    body: `[a-km-np-zA-KM-NP-Z2-9]{26}${EDGE_AFTER}`,
    edge: true,
    keepTail: false,
  },
];

const PREFIXED = SHAPES.map(
  (s) =>
    [
      new RegExp(
        `${s.edge ? EDGE_BEFORE : ""}(${s.prefixes.map(anyCase).join("|")})(${s.body})`,
        "g",
      ),
      s.keepTail,
    ] as const,
);

// Secrets with no prefix of their own, known by the name they're given: an
// OAuth code or PKCE verifier, a push URL's signing secret, any other token
// or secret (push_secret, session_token, CODE=, "Signing secret:"). In JSON,
// escaped or not, as name=value, and as "name: value" in prose. A value
// needs a capital or a digit, and one in capitals alone is a name, so error
// codes such as invalid_connect_code or ERR_INVALID_ARG_TYPE stay; so does a
// path (code: src/lib/Some_File.ts), which none of these secrets looks like.
// The name's length is bounded so a long run of letters costs one pass.
const NAME = `[A-Za-z_]{0,40}(?:${["secret", "token", "verifier", "code"].map(anyCase).join("|")})`;
const VALUE = "[A-Za-z0-9_.~+/=%\\-]";
const NAMED = new RegExp(
  `((?<![A-Za-z0-9])(?:\\\\*")?${NAME}(?:\\\\*")?\\s*[:=]\\s*(?:\\\\*"|'|\`)?)(${VALUE}{16,})`,
  "g",
);
const SHOUTED = /^[A-Z][A-Z0-9_]*$/;
const PATH = /\/|\.[A-Za-z][A-Za-z0-9]{0,5}$/;
const keep = (value: string) => {
  const v = value.replace(/\.+$/, "");
  return !/[A-Z0-9]/.test(v) || SHOUTED.test(v) || PATH.test(v);
};

// Last, secrets with no prefix and no name: a run of 64 hex characters (a
// push secret) or of 43 base64url characters with capitals and small
// letters (an OAuth code or verifier, 32 bytes).
const BARE_EDGE = `(?:(?<![${B64}])|${ESCAPED})`;
const BARE_HEX = new RegExp(`${BARE_EDGE}[0-9a-fA-F]{64}(?![${B64}])`, "g");
const BARE_B64 = new RegExp(
  `${BARE_EDGE}(?=[${B64}]{0,42}[A-Z])(?=[${B64}]{0,42}[a-z])[${B64}]{43}(?![${B64}])`,
  "g",
);

export function redact(text: string): string {
  let out = text;
  for (const [re, keepTail] of PREFIXED)
    out = out.replace(
      re,
      (_m, prefix: string, body: string) =>
        `${prefix}…${keepTail ? body.slice(-4) : ""}`,
    );
  // A value that was already cut down above is left as it is: its … isn't
  // part of a value. A full stop that ends a sentence stays.
  out = out.replace(NAMED, (m, name: string, value: string) =>
    keep(value) ? m : `${name}[redacted]${value.match(/\.+$/)?.[0] ?? ""}`,
  );
  out = out.replace(BARE_HEX, "[redacted]");
  out = out.replace(BARE_B64, "[redacted]");
  return out;
}
