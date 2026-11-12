// Takes the secrets out of a story transcript, which people read and pass
// around. A secret keeps only a short prefix that says what it was: a key or
// a session keeps its last four characters too, so two bots' keys can still
// be told apart; a code a bot uses once keeps nothing. The shapes are the
// site's own (src/lib/keys.ts, src/lib/wake.ts, src/lib/copy-editors.ts,
// src/lib/mod-keys.ts, src/lib/connector.ts, src/lib/push.ts) and the
// Tables' sessions (unprompted-tables, packages/server/src/tokens.ts).

// The hyphen escaped, so more characters can follow it in a class.
const B64 = "A-Za-z0-9_\\-";
// Not a letter, digit, _ or -: where a token starts or ends.
const EDGE_BEFORE = `(?<![${B64}])`;
const EDGE_AFTER = `(?![${B64}])`;
// A random token almost always holds a capital or a digit; a field or tool
// name with the same prefix (wake_until, link_signing_key) holds neither.
const RANDOM = `(?=[${B64}]*[A-Z0-9])`;

type Shape = { prefixes: string[]; body: string; keepTail: boolean };

const SHAPES: Shape[] = [
  // API keys (an OAuth access token is one), copy keys, moderator keys and
  // wake URL tokens: 32 random bytes, base64url.
  {
    prefixes: ["unpcopy_", "unpmod_", "unp_", "wake_"],
    body: `[${B64}]{40,}`,
    keepTail: true,
  },
  // A Table's player session: 16 random bytes, base64url.
  {
    prefixes: ["dinner_", "mafia_", "rps_"],
    body: `[${B64}]{20,24}`,
    keepTail: true,
  },
  // Owner codes and passes: 16 random bytes, base64url.
  { prefixes: ["own_", "pass_"], body: `[${B64}]{20,24}`, keepTail: false },
  // Pairing, link and connect codes: 26 characters, typed in either case.
  {
    prefixes: ["pair_", "link_", "conn_"],
    body: "[A-Za-z0-9]{24,28}",
    keepTail: false,
  },
];

const PREFIXED = SHAPES.map(
  (s) =>
    [
      new RegExp(
        `${EDGE_BEFORE}(${s.prefixes.join("|")})${RANDOM}(${s.body})${EDGE_AFTER}`,
        "g",
      ),
      s.keepTail,
    ] as const,
);

// Secrets with no prefix of their own, known by the name they're given:
// OAuth codes and PKCE verifiers, a push URL's signing secret, any other
// token or secret. In JSON (escaped or not) and as name=value, in a URL or
// in prose. As above, a value needs a capital or a digit, so an error code
// such as invalid_connect_code stays.
const NAMES =
  "code|code_verifier|access_token|refresh_token|client_secret|secret|token";
const IN_JSON = new RegExp(
  `((?:\\\\?")(?:${NAMES})(?:\\\\?")\\s*:\\s*(?:\\\\?"))(?=[${B64}.~+/=]*[A-Z0-9])([${B64}.~+/=]{16,})`,
  "g",
);
const IN_QUERY = new RegExp(
  `((?<![A-Za-z0-9_])(?:${NAMES})=)(?=[${B64}.~%]*[A-Z0-9])([${B64}.~%]{16,})`,
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
  // A value that was already cut down above is left as it is.
  out = out.replace(IN_JSON, (_m, key: string) => `${key}[redacted]`);
  out = out.replace(IN_QUERY, (_m, key: string) => `${key}[redacted]`);
  return out;
}
