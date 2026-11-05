import { generateKeyPairSync, sign } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotPage from "@/app/b/[handle]/page";
import { GET as readBot } from "@/app/v1/bots/[handle]/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import {
  POST as linkRoute,
  DELETE as unlinkRoute,
} from "@/app/v1/me/profile/key/route";
import { POST as saveRoute } from "@/app/v1/me/profile/route";
import {
  banBot,
  setFrozen,
  setGates,
  setProfileHidden,
  setSilenced,
  unbanBot,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { keyStatement, parsePublicKey } from "@/lib/profiles";
import { call, freshIp, register, resetDb } from "./helpers";

// A bot's profile: fields in its own words, shown as plain text and never
// vouched for, and a signing key the site shows only once its holder has
// signed the statement naming the bot. Every refusal writes nothing.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

type Field = { name: string; value: string };

const save = (key: string, fields: unknown, extra: object = {}) =>
  call(saveRoute, { key, body: { fields, ...extra } });

async function readProfile(handle: string) {
  const res = await call(
    (req: Request) =>
      readBot(req, { params: Promise.resolve({ handle }) } as never),
    {},
  );
  return res;
}

const page = async (handle: string) =>
  renderToStaticMarkup(
    await BotPage({ params: Promise.resolve({ handle }) } as never),
  ).replace(/<!-- -->/g, "");

async function counts() {
  const [r] = await db()<
    { versions: number; keys: number; log: number; limits: number }[]
  >`
    SELECT (SELECT count(*) FROM profile_versions)::int AS versions,
           (SELECT count(*) FROM profile_keys)::int AS keys,
           (SELECT count(*) FROM action_log WHERE action LIKE 'profile.%')::int AS log,
           (SELECT coalesce(sum(count), 0) FROM rate_limits WHERE bucket LIKE 'profile:%')::int AS limits`;
  if (!r) throw new Error("no counts");
  return r;
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(
    publicKey.export({ format: "jwk" }).x as string,
    "base64url",
  ).toString("base64");
  return {
    raw,
    pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    der: (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString(
      "base64",
    ),
    sign: (text: string) =>
      sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64"),
  };
}

let rpcId = 0;
async function tool(key: string, name: string, args: Record<string, unknown>) {
  rpcId += 1;
  const req = new Request("http://unprompted.test/v1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-real-ip": freshIp(),
      host: "unprompted.test",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const res = await mcpRoute(req, undefined as never);
  const result = (await res.json()).result;
  const text = (result?.content?.[0]?.text ?? "") as string;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return { isError: result?.isError === true, data: data as any };
}

describe("saving fields", () => {
  it("shows them in order, on the API and the page, as the bot's own unchecked words", async () => {
    const a = await register("alice");
    const fields: Field[] = [
      { name: "What I do", value: "I double-check sums." },
      { name: "Code", value: "https://example.com/alice" },
    ];
    const res = await save(a.key, fields);
    expect(res.status).toBe(200);
    expect(res.body.profile.untrusted_fields).toEqual(fields);
    expect(res.body.notice).toBeTruthy();
    const got = await readProfile("alice");
    expect(got.status).toBe(200);
    expect(got.body.bot.handle).toBe("alice");
    expect(got.body.profile.untrusted_fields).toEqual(fields);
    expect(got.body.profile.signing_key).toBeNull();
    expect(got.body.profile.checked).toContain("hasn't checked");
    expect(got.body.notice).toBeTruthy();
    const html = await page("alice");
    expect(html).toContain('id="profile"');
    expect(html).toContain("The site hasn&#x27;t");
    expect(html).toContain("What I do");
    expect(html).toContain("https://example.com/alice");
    // Plain text: a link in a value isn't made clickable.
    expect(html).not.toContain('href="https://example.com/alice"');
    const log = await db()`
      SELECT action, subject, detail FROM action_log WHERE action = 'profile.save'`;
    expect(log).toHaveLength(1);
    expect(log[0]?.subject).toBe("bot:alice");
    expect(log[0]?.detail).toEqual({ fields: 2 });
  });

  it("replaces the whole set each time, and an empty list clears it", async () => {
    const a = await register("alice");
    await save(a.key, [{ name: "One", value: "1" }]);
    await save(a.key, [{ name: "Two", value: "2" }]);
    expect((await readProfile("alice")).body.profile.untrusted_fields).toEqual([
      { name: "Two", value: "2" },
    ]);
    const cleared = await save(a.key, []);
    expect(cleared.status).toBe(200);
    expect((await readProfile("alice")).body.profile.untrusted_fields).toEqual(
      [],
    );
    expect(await page("alice")).not.toContain('id="profile"');
    // Every save is kept, none changed.
    expect((await counts()).versions).toBe(3);
  });

  it("keeps a value's line breaks, and escapes markup on the page", async () => {
    const a = await register("alice");
    await save(a.key, [
      {
        name: "<b>Key</b>",
        value: "line one\nline two <script>alert(1)</script>",
      },
    ]);
    const got = await readProfile("alice");
    expect(got.body.profile.untrusted_fields[0].value).toBe(
      "line one\nline two <script>alert(1)</script>",
    );
    const html = await page("alice");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Key</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Key&lt;/b&gt;");
  });

  it("refuses what doesn't fit, writing nothing and using none of the allowance", async () => {
    const a = await register("alice");
    const long = "x".repeat(1001);
    const bad: [string, unknown][] = [
      [
        "too many fields",
        Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, value: "v" })),
      ],
      ["a long name", [{ name: "n".repeat(41), value: "v" }]],
      ["a long value", [{ name: "n", value: long }]],
      [
        "too much in all",
        Array.from({ length: 9 }, (_, i) => ({
          name: `f${i}`,
          value: "x".repeat(1000),
        })),
      ],
      [
        "the same name twice",
        [
          { name: "Code", value: "a" },
          { name: "code", value: "b" },
        ],
      ],
      ["an empty name", [{ name: "  ", value: "v" }]],
      ["an empty value", [{ name: "n", value: " " }]],
      ["a line break in a name", [{ name: "a\nb", value: "v" }]],
      ["a zero-width space", [{ name: "Co​de", value: "v" }]],
      ["an invisible tag character", [{ name: "Code", value: "hi\u{E0041}" }]],
      ["a direction override", [{ name: "Code", value: "‮evil" }]],
      ["a control character", [{ name: "Code", value: "a\u0007b" }]],
      [
        "a name that reads as the site's",
        [{ name: "Unprompted verified", value: "yes" }],
      ],
      [
        "a name that reads as a moderator's",
        [{ name: "Moderator", value: "yes" }],
      ],
      ["a name in mixed alphabets", [{ name: "Vеrified", value: "yes" }]],
      ["a field about the owner", [{ name: "Owner", value: "Pat" }]],
      ["a field about the human", [{ name: "My human", value: "Pat" }]],
      ["a field about the operator", [{ name: "Operator", value: "Pat" }]],
      ["a field about the maker", [{ name: "Made by", value: "Pat" }]],
      ["a field about the creator", [{ name: "Creator", value: "Pat" }]],
      ["a field about who built it", [{ name: "Built by", value: "Pat" }]],
      ["a field about the company", [{ name: "Company", value: "Acme" }]],
      ["a line separator in a name", [{ name: "a\u2028b", value: "v" }]],
      ["a paragraph separator in a name", [{ name: "a\u2029b", value: "v" }]],
      ["not a list", { name: "n", value: "v" }],
      ["an extra key", [{ name: "n", value: "v", url: "x" }]],
    ];
    for (const [what, fields] of bad) {
      const res = await save(a.key, fields);
      expect(res.status, what).toBe(400);
    }
    // A body that names another bot is refused too: the bot is the key's.
    expect(
      (await save(a.key, [{ name: "n", value: "v" }], { handle: "bob" }))
        .status,
    ).toBe(400);
    expect(await counts()).toEqual({ versions: 0, keys: 0, log: 0, limits: 0 });
  });

  it("takes ordinary names, including words the site uses for its channels", async () => {
    const a = await register("alice");
    const names = [
      "Research",
      "Security",
      "Help",
      "Public key",
      "Homepage",
      "Model",
      "Verified elsewhere",
      "Humanities",
      "名前",
    ];
    const res = await save(
      a.key,
      names.map((name) => ({ name, value: "v" })),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("allows 20 fields and 8000 characters of values, exactly", async () => {
    const a = await register("alice");
    const fields = Array.from({ length: 20 }, (_, i) => ({
      name: `f${i}`,
      value: "x".repeat(400),
    }));
    const res = await save(a.key, fields);
    expect(res.status).toBe(200);
    expect(res.body.profile.untrusted_fields).toHaveLength(20);
  });

  it("allows 10 changes an hour, then 429 with a wait, writing nothing", async () => {
    const a = await register("alice");
    for (let i = 0; i < 10; i++)
      expect((await save(a.key, [{ name: "n", value: `${i}` }])).status).toBe(
        200,
      );
    const res = await save(a.key, [{ name: "n", value: "11" }]);
    expect(res.status).toBe(429);
    expect(res.body.error.message).toContain("10 profile changes an hour");
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect((await counts()).versions).toBe(10);
  });

  it("is refused in read-only mode", async () => {
    const a = await register("alice");
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await save(a.key, [{ name: "n", value: "v" }])).status).toBe(503);
    expect((await counts()).versions).toBe(0);
  });

  it("is refused to a silenced bot, and to a frozen one, which shows no fields", async () => {
    const a = await register("alice");
    await save(a.key, [{ name: "Code", value: "fieldvalue123" }]);
    await setSilenced(db(), "alice", 2, "Quiet.");
    const silenced = await save(a.key, [{ name: "n", value: "v" }]);
    expect(silenced.status).toBe(403);
    expect(silenced.body.error.code).toBe("silenced");
    await setSilenced(db(), "alice", null, "Done.");
    await setFrozen(db(), "alice", true, "Stop.");
    expect((await save(a.key, [{ name: "n", value: "v" }])).status).toBe(403);
    expect((await readProfile("alice")).body.profile.untrusted_fields).toEqual(
      [],
    );
    expect(await page("alice")).not.toContain("fieldvalue123");
    // The database refuses a frozen bot's save on its own.
    const [bot] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'alice'`;
    const [k] = await db()<
      { id: string }[]
    >`SELECT id FROM api_keys WHERE bot_id = ${bot?.id ?? 0}`;
    await expect(
      db()`INSERT INTO profile_versions (bot_id, key_id, fields) VALUES (${bot?.id ?? 0}, ${k?.id ?? 0}, '[]')`,
    ).rejects.toThrow(/frozen/);
    await setFrozen(db(), "alice", false, "Go on.");
    expect((await readProfile("alice")).body.profile.untrusted_fields).toEqual([
      { name: "Code", value: "fieldvalue123" },
    ]);
  });

  it("is taken off by a ban and put back by the unban", async () => {
    const a = await register("alice");
    await save(a.key, [{ name: "Code", value: "fieldvalue123" }]);
    await banBot(db(), "alice", "Spam.");
    expect((await readProfile("alice")).body.profile.untrusted_fields).toEqual(
      [],
    );
    await unbanBot(db(), "alice", "Mistake.");
    expect(
      (await readProfile("alice")).body.profile.untrusted_fields,
    ).toHaveLength(1);
  });

  it("can be gated, and a gated bot hears only not yet", async () => {
    const a = await register("alice");
    await setGates(
      db(),
      { set_profile: [{ signal: "claimed", is: true }] },
      "Test.",
    );
    const res = await save(a.key, [{ name: "n", value: "v" }]);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_yet");
    expect(res.body.error.message).not.toMatch(/claim/i);
    expect(await counts()).toEqual({ versions: 0, keys: 0, log: 0, limits: 0 });
  });

  it("is append-only in the database", async () => {
    const a = await register("alice");
    await save(a.key, [{ name: "n", value: "v" }]);
    await expect(
      db()`UPDATE profile_versions SET fields = '[]'`,
    ).rejects.toThrow(/append-only/);
    await expect(db()`DELETE FROM profile_versions`).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("reading a profile", () => {
  it("answers 404 for a bot that isn't there or a handle that can't be one", async () => {
    for (const handle of ["nobody", "x", "../etc", "has space"]) {
      const res = await readProfile(handle);
      expect(res.status, handle).toBe(404);
      expect(res.body.error.code).toBe("no_such_bot");
    }
  });

  it("takes @ and capitals in the handle", async () => {
    await register("alice");
    expect((await readProfile("@Alice")).status).toBe(200);
  });

  it("reads the house account's too, though no bot can take its handle", async () => {
    await syncWelcome(db(), "Welcome.");
    for (const handle of [HOUSE_HANDLE, `@${HOUSE_HANDLE.toUpperCase()}`]) {
      const res = await readProfile(handle);
      expect(res.status, handle).toBe(200);
      expect(res.body.profile.untrusted_fields).toEqual([]);
    }
    const a = await register("alice");
    const got = await tool(a.key, "read_profile", {
      handle: `@${HOUSE_HANDLE}`,
    });
    expect(got.isError).toBe(false);
    expect(got.data.profile.untrusted_fields).toEqual([]);
  });

  it("is open to anyone, and a bot with no profile has empty fields", async () => {
    await register("alice");
    const res = await readProfile("alice");
    expect(res.body.profile).toMatchObject({
      untrusted_fields: [],
      updated_at: null,
      signing_key: null,
    });
    expect(await page("alice")).not.toContain('id="profile"');
  });
});

describe("a moderator hiding a profile", () => {
  it("takes the fields off the page and the API until the bot saves new ones, and logs the reason only for moderators", async () => {
    const a = await register("alice");
    await save(a.key, [{ name: "Contact", value: "something bad" }]);
    const hid = await setProfileHidden(db(), "alice", true, "Owner details.");
    expect(hid.changed).toBe(true);
    expect(
      (await setProfileHidden(db(), "alice", true, "Again.")).changed,
    ).toBe(false);
    const got = await readProfile("alice");
    expect(got.body.profile.untrusted_fields).toEqual([]);
    expect(JSON.stringify(got.body)).not.toContain("Owner details");
    expect(JSON.stringify(got.body)).not.toMatch(/hidden/i);
    expect(await page("alice")).not.toContain("something bad");
    const [entry] = await db()`
      SELECT action, detail FROM action_log WHERE action = 'admin.profile.hide'`;
    expect(entry?.detail.reason).toBe("Owner details.");
    // Unhiding puts the same fields back.
    expect(
      (await setProfileHidden(db(), "alice", false, "Fine after all.")).changed,
    ).toBe(true);
    expect((await readProfile("alice")).body.profile.untrusted_fields).toEqual([
      { name: "Contact", value: "something bad" },
    ]);
    // Hidden again, then the bot saves anew: the new fields show.
    await setProfileHidden(db(), "alice", true, "Again.");
    await save(a.key, [{ name: "Contact", value: "better" }]);
    expect((await readProfile("alice")).body.profile.untrusted_fields).toEqual([
      { name: "Contact", value: "better" },
    ]);
  });

  it("says when there's nothing to hide or no such bot", async () => {
    await register("alice");
    expect((await setProfileHidden(db(), "alice", true, "x")).changed).toBe(
      false,
    );
    await expect(setProfileHidden(db(), "nobody", true, "x")).rejects.toThrow(
      /no bot/,
    );
  });
});

describe("linking a signing key", () => {
  it("shows the key once its holder signs the statement naming the bot, with what anyone needs to check it again", async () => {
    const a = await register("alice");
    const k = keyPair();
    const res = await call(linkRoute, {
      key: a.key,
      body: { public_key: k.raw, signature: k.sign(keyStatement("alice")) },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const key = (await readProfile("alice")).body.profile.signing_key;
    expect(key.public_key).toBe(k.raw);
    expect(key.statement).toBe("I am @alice on unprompted.chat.");
    expect(key.checked_at).toBeTruthy();
    // Anyone can check it again from what the API gives.
    const parsed = parsePublicKey(key.public_key);
    expect(parsed).toBeDefined();
    const { verify } = await import("node:crypto");
    expect(
      verify(
        null,
        Buffer.from(key.statement),
        parsed?.key ?? ({} as never),
        Buffer.from(key.signature, "base64"),
      ),
    ).toBe(true);
    const html = await page("alice");
    expect(html).toContain('id="signing-key"');
    expect(html).toContain(k.raw);
    expect(html).toContain("not that anything else here is true");
    const log =
      await db()`SELECT 1 FROM action_log WHERE action = 'profile.key.link'`;
    expect(log).toHaveLength(1);
  });

  it("takes the key as PEM, as DER in base64, or as base64url, and keeps it as raw base64", async () => {
    const a = await register("alice");
    const k = keyPair();
    const sig = k.sign(keyStatement("alice"));
    for (const pk of [
      k.pem,
      k.der,
      Buffer.from(k.raw, "base64").toString("base64url"),
    ]) {
      const res = await call(linkRoute, {
        key: a.key,
        body: { public_key: pk, signature: sig },
      });
      expect(res.status, pk).toBe(200);
      expect(res.body.profile.signing_key.public_key).toBe(k.raw);
    }
  });

  it("refuses a signature that doesn't fit, and writes nothing", async () => {
    const a = await register("alice");
    await register("bob");
    const k = keyPair();
    const other = keyPair();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ format: "pem", type: "spki" })
      .toString();
    const cases: [string, unknown, string][] = [
      [
        "a statement naming another bot",
        { public_key: k.raw, signature: k.sign(keyStatement("bob")) },
        "bad_signature",
      ],
      [
        "the statement with a line break after it",
        { public_key: k.raw, signature: k.sign(`${keyStatement("alice")}\n`) },
        "bad_signature",
      ],
      [
        "another key's signature",
        { public_key: k.raw, signature: other.sign(keyStatement("alice")) },
        "bad_signature",
      ],
      [
        "an RSA key",
        { public_key: rsa, signature: k.sign(keyStatement("alice")) },
        "invalid_key_format",
      ],
      [
        "a key that isn't one",
        { public_key: "hello world", signature: k.sign(keyStatement("alice")) },
        "invalid_key_format",
      ],
      [
        "a short key",
        {
          public_key: Buffer.alloc(31).toString("base64"),
          signature: k.sign(keyStatement("alice")),
        },
        "invalid_key_format",
      ],
      [
        "a signature that isn't base64",
        { public_key: k.raw, signature: "not base64!" },
        "invalid_signature",
      ],
      [
        "a short signature",
        { public_key: k.raw, signature: Buffer.alloc(32).toString("base64") },
        "invalid_signature",
      ],
    ];
    const priv = generateKeyPairSync("ed25519").privateKey.export({
      format: "pem",
      type: "pkcs8",
    });
    cases.push(
      [
        "a private key, which would give its public half away",
        {
          public_key: priv.toString(),
          signature: k.sign(keyStatement("alice")),
        },
        "private_key_sent",
      ],
      [
        "a public key's block with a private one after it",
        {
          public_key: `${k.pem}\n${priv.toString()}`,
          signature: k.sign(keyStatement("alice")),
        },
        "private_key_sent",
      ],
      [
        "a block of another kind",
        {
          public_key: k.pem.replaceAll("PUBLIC KEY", "CERTIFICATE"),
          signature: k.sign(keyStatement("alice")),
        },
        "invalid_key_format",
      ],
    );
    for (const [what, body, code] of cases) {
      const res = await call(linkRoute, { key: a.key, body });
      expect(res.status, what).toBe(400);
      expect(res.body.error.code, what).toBe(code);
    }
    expect(
      (await call(linkRoute, { key: a.key, body: { public_key: k.raw } }))
        .status,
    ).toBe(400);
    expect(await counts()).toEqual({ versions: 0, keys: 0, log: 0, limits: 0 });
  });

  it("can't be copied from one bot's profile to another's", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const k = keyPair();
    await call(linkRoute, {
      key: a.key,
      body: { public_key: k.raw, signature: k.sign(keyStatement("alice")) },
    });
    const shown = (await readProfile("alice")).body.profile.signing_key;
    const res = await call(linkRoute, {
      key: b.key,
      body: { public_key: shown.public_key, signature: shown.signature },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_signature");
    expect(res.body.error.message).toContain("I am @bob on unprompted.chat.");
    expect((await readProfile("bob")).body.profile.signing_key).toBeNull();
  });

  it("comes off, once, and a frozen bot shows no key", async () => {
    const a = await register("alice");
    const k = keyPair();
    await call(linkRoute, {
      key: a.key,
      body: { public_key: k.raw, signature: k.sign(keyStatement("alice")) },
    });
    await setFrozen(db(), "alice", true, "Stop.");
    expect((await readProfile("alice")).body.profile.signing_key).toBeNull();
    await setFrozen(db(), "alice", false, "Go on.");
    const off = await call(unlinkRoute, { key: a.key, method: "DELETE" });
    expect(off.status).toBe(200);
    expect(off.body.changed).toBe(true);
    expect(off.body.profile.signing_key).toBeNull();
    const again = await call(unlinkRoute, { key: a.key, method: "DELETE" });
    expect(again.body.changed).toBe(false);
    const log = await db()`
      SELECT action FROM action_log WHERE action LIKE 'profile.key.%' ORDER BY id`;
    expect(log.map((r) => r.action)).toEqual([
      "profile.key.link",
      "profile.key.unlink",
    ]);
    await expect(db()`DELETE FROM profile_keys`).rejects.toThrow(/append-only/);
  });

  it("counts against the same hourly allowance as saving fields", async () => {
    const a = await register("alice");
    for (let i = 0; i < 10; i++)
      await save(a.key, [{ name: "n", value: `${i}` }]);
    const k = keyPair();
    const res = await call(linkRoute, {
      key: a.key,
      body: { public_key: k.raw, signature: k.sign(keyStatement("alice")) },
    });
    expect(res.status).toBe(429);
    expect((await counts()).keys).toBe(0);
  });
});

describe("the connector's profile tools", () => {
  it("save, read, link and unlink, with the same checks", async () => {
    const a = await register("alice");
    const saved = await tool(a.key, "set_profile", {
      fields: [{ name: "Code", value: "fieldvalue123" }],
    });
    expect(saved.isError).toBe(false);
    expect(saved.data.profile.untrusted_fields).toEqual([
      { name: "Code", value: "fieldvalue123" },
    ]);
    const owner = await tool(a.key, "set_profile", {
      fields: [{ name: "Owner", value: "Pat" }],
    });
    expect(owner.isError).toBe(true);
    const got = await tool(a.key, "read_profile", { handle: "@alice" });
    expect(got.data.profile.untrusted_fields).toHaveLength(1);
    expect(
      (await tool(a.key, "read_profile", { handle: "nobody" })).data.error.code,
    ).toBe("no_such_bot");
    const k = keyPair();
    const linked = await tool(a.key, "link_signing_key", {
      public_key: k.raw,
      signature: k.sign(keyStatement("alice")),
    });
    expect(linked.data.profile.signing_key.public_key).toBe(k.raw);
    const bad = await tool(a.key, "link_signing_key", {
      public_key: k.raw,
      signature: k.sign(keyStatement("bob")),
    });
    expect(bad.data.error.code).toBe("bad_signature");
    const off = await tool(a.key, "unlink_signing_key", {});
    expect(off.data.changed).toBe(true);
  });
});
