import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COPY_KEY_PREFIX } from "@/lib/copy-editors";
import {
  newKey,
  newLinkCode,
  newOwnerCode,
  newPairingCode,
  newPass,
} from "@/lib/keys";
import { MOD_KEY_PREFIX } from "@/lib/mod-keys";
import { WAKE_URL_PREFIX } from "@/lib/wake";
import { redact } from "../../evals/stories/redact";

// A story transcript (evals/stories/digest.ts) is read and passed around, so
// it never carries a secret: one sample of every shape the site or a Table
// issues goes in, and only a short prefix comes out.

const b64 = (bytes: number) => randomBytes(bytes).toString("base64url");
// What PAIRING_ALPHABET draws from, for a connect code (conn_, 26 of them).
const code26 = () =>
  Array.from(
    randomBytes(26),
    (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b & 31],
  ).join("");

const SAMPLES = () => {
  const key = newKey().secret;
  const copyKey = COPY_KEY_PREFIX + b64(32);
  const modKey = MOD_KEY_PREFIX + b64(32);
  const wake = WAKE_URL_PREFIX + b64(32);
  const session = `dinner_${b64(16)}`;
  return [
    { name: "API key", secret: key, shown: `unp_…${key.slice(-4)}` },
    {
      name: "copy key",
      secret: copyKey,
      shown: `unpcopy_…${copyKey.slice(-4)}`,
    },
    {
      name: "moderator key",
      secret: modKey,
      shown: `unpmod_…${modKey.slice(-4)}`,
    },
    {
      name: "wake URL token",
      secret: wake,
      shown: `wake_…${wake.slice(-4)}`,
    },
    {
      name: "Table session",
      secret: session,
      shown: `dinner_…${session.slice(-4)}`,
    },
    { name: "owner code", secret: newOwnerCode().code, shown: "own_…" },
    { name: "pass", secret: newPass().pass, shown: "pass_…" },
    { name: "pairing code", secret: newPairingCode().code, shown: "pair_…" },
    { name: "link code", secret: newLinkCode().code, shown: "link_…" },
    { name: "connect code", secret: `conn_${code26()}`, shown: "conn_…" },
    {
      name: "connect code typed in capitals",
      secret: `conn_${code26().toUpperCase()}`,
      shown: "conn_…",
    },
  ];
};

describe("redacting a story transcript", () => {
  for (const s of SAMPLES())
    it(`cuts a ${s.name} to its prefix`, () => {
      for (const around of [
        (x: string) => `Authorization: Bearer ${x}`,
        (x: string) => `{"api_key":"${x}","note":"keep it"}`,
        // Inside JSON that was itself put in a string, as tool input is.
        (x: string) => `{\\"session\\":\\"${x}\\"}`,
        (x: string) => `http://localhost:3740/v1/wake/${x}.`,
        (x: string) => `(${x})`,
      ]) {
        const out = redact(around(s.secret));
        expect(out).toBe(around(s.shown));
        expect(out).not.toContain(s.secret);
      }
    });

  it("cuts an OAuth code and a PKCE verifier, in a redirect and in JSON", () => {
    const code = b64(32);
    const verifier = b64(32);
    const back = `http://localhost:47615/callback?code=${code}&state=story`;
    expect(redact(back)).toBe(
      "http://localhost:47615/callback?code=[redacted]&state=story",
    );
    const swap = JSON.stringify({ code, code_verifier: verifier });
    expect(redact(swap)).toBe(
      '{"code":"[redacted]","code_verifier":"[redacted]"}',
    );
    const escaped = `{\\"code\\":\\"${code}\\"}`;
    expect(redact(escaped)).toBe('{\\"code\\":\\"[redacted]\\"}');
  });

  it("cuts a push URL's signing secret and an access token", () => {
    const secret = randomBytes(32).toString("hex");
    const token = newKey().secret;
    const out = redact(
      JSON.stringify({ secret, access_token: token, token_type: "Bearer" }),
    );
    expect(out).toBe(
      `{"secret":"[redacted]","access_token":"unp_…${token.slice(-4)}","token_type":"Bearer"}`,
    );
  });

  it("leaves names, error codes and a key's shown prefix alone", () => {
    const plain = [
      "wake_until",
      "link_signing_key",
      "make_wake_url",
      "get_link_code",
      "redeem_pairing_code",
      "pass_through_the_whole_thing_quietly",
      '{"error":{"code":"invalid_connect_code"}}',
      '{"key_prefix":"unp_abcd"}',
      "Send your session in the header: Authorization: Bearer dinner_...",
      "m_ab12CD34ef56",
    ].join("\n");
    expect(redact(plain)).toBe(plain);
  });
});

describe("the digest of a run", () => {
  it("writes no secret, even one a cut line would split", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "story-redact-"));
    const key = newKey().secret;
    const pair = newPairingCode().code;
    const session = `rps_${b64(16)}`;
    const code = b64(32);
    // A tool answer whose 500-character cut lands inside the key.
    const answer = `${"x".repeat(480)} ${key} and more`;
    const visit = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "mcp__unprompted__redeem_pairing_code",
              input: { code: pair },
            },
            { type: "text", text: `My session is ${session}.` },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", content: answer }] },
      },
      { type: "result", result: `Done. Back with code=${code}&state=x` },
    ];
    mkdirSync(path.join(dir, "alice", "visits"), { recursive: true });
    writeFileSync(
      path.join(dir, "alice", "visits", "1.jsonl"),
      visit.map((v) => JSON.stringify(v)).join("\n"),
    );
    writeFileSync(
      path.join(dir, "results.json"),
      JSON.stringify({
        story: "s0",
        arm: "test",
        title: "Redaction",
        started: "2026-11-12T00:00:00Z",
        minutes: 10,
        events: [
          {
            bot: "alice",
            prompt: `Your key is ${key}`,
            visit: 1,
            min: 0,
            causes: ["owner line"],
          },
          { bot: "alice", done: true, visit: 1, min: 2, lane: "a" },
        ],
        bots: [
          {
            name: "alice",
            owner: "Ann",
            profile: "p",
            model: "m",
            line: `Use ${newOwnerCode().code}`,
            host: [
              {
                at: "2026-11-12T00:01:00Z",
                kind: "tell_owner",
                text: `link code ${newLinkCode().code}`,
              },
            ],
            visits: [{ inputTokens: 1 }],
            costUsd: 0,
          },
        ],
        posts: [],
        subjects: [],
        actions: {},
        collected: { pass: newPass().pass },
      }),
    );
    const run = spawnSync(
      "npx",
      ["tsx", path.join(process.cwd(), "evals/stories/digest.ts"), dir],
      { encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
    const t = readFileSync(path.join(dir, "transcript.md"), "utf8");
    expect(t).toContain(`unp_…${key.slice(-4)}`);
    expect(t).toContain("pair_…");
    expect(t).toContain(`rps_…${session.slice(-4)}`);
    expect(t).toContain("code=[redacted]");
    // Nothing of any secret's random part survives, whole or cut.
    for (const secret of [key, pair, session, code])
      expect(t).not.toContain(secret.slice(-20, -4));
    expect(t).not.toMatch(
      /(unp|own|pass|pair|link|conn|wake|rps)_[A-Za-z0-9_-]{8,}/,
    );
  });
});
