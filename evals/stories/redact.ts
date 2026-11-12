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

// Every prefix below, so a token's body can't start with one: in
// pass_pass_…, the token is the second, and cutting the first would leave
// the end of the real one showing.
const ALL_PREFIXES = [
  "unpcopy_",
  "unpmod_",
  "unp_",
  "wake_",
  "dinner_",
  "mafia_",
  "rps_",
  "own_",
  "pass_",
  "pair_",
  "link_",
  "conn_",
];
const NOT_A_PREFIX = `(?!${ALL_PREFIXES.map((p) => anyCase(p)).join("|")})`;

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
  // The exact-length shapes are cut at their length whatever follows: a
  // transcript is better off with part of an odd handle cut
  // (rps_champion_2026_the_best) than with a token that a word follows
  // (rps_…_alice) left whole.
  {
    prefixes: ["dinner_", "mafia_", "rps_"],
    body: `${NOT_A_PREFIX}${random(22)}[${B64}]{22}`,
    edge: true,
    keepTail: true,
  },
  // Owner codes and passes: the same 22.
  {
    prefixes: ["own_", "pass_"],
    body: `${NOT_A_PREFIX}${random(22)}[${B64}]{22}`,
    edge: true,
    keepTail: false,
  },
  // Pairing, link and connect codes: 26 from an alphabet with no l, o, 0 or
  // 1, typed in either case. About one in 1,700 has no digit, so the
  // alphabet, not RANDOM, is what tells one from a word.
  {
    prefixes: ["pair_", "link_", "conn_"],
    body: `${NOT_A_PREFIX}[a-km-np-zA-KM-NP-Z2-9]{26}`,
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
// A path: from the root, here or a folder up, or a folder in small letters,
// or a source file by its extension. Anything else with a / in it may be
// standard base64.
const PATH =
  /^(?:\/|\.\.?\/|[a-z][a-z0-9_-]*\/)|\.(?:ts|tsx|js|json|md|sql|yaml|yml|txt|log)$/;
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

// A log written as it streams in (a server's output): redacted a line at a
// time, so a token split across two chunks is still whole when it's looked
// at. What's left without a newline is written at the end.
export function redactLines(write: (text: string) => void): {
  push: (chunk: string) => void;
  end: () => void;
} {
  let rest = "";
  return {
    push: (chunk) => {
      rest += chunk;
      const cut = rest.lastIndexOf("\n");
      if (cut < 0) return;
      write(redact(rest.slice(0, cut + 1)));
      rest = rest.slice(cut + 1);
    },
    end: () => {
      if (rest) write(redact(rest));
      rest = "";
    },
  };
}

// Where a child process's output goes: into a file, redacted (redactLines),
// each stream on its own lines so stdout and stderr don't cut each other's.
export function redactedSink(
  append: (text: string) => void,
  streams: (NodeJS.ReadableStream | null | undefined)[],
): void {
  for (const s of streams) {
    if (!s) continue;
    const lines = redactLines(append);
    s.setEncoding("utf8");
    s.on("data", (c: string) => lines.push(c));
    s.on("end", () => lines.end());
  }
}
