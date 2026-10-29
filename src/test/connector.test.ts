import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as revokeRoute } from "@/app/v1/me/keys/revoke/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { GET as metadataRoute } from "@/app/v1/oauth/metadata/route";
import { POST as registerClientRoute } from "@/app/v1/oauth/register/route";
import { GET as resourceRoute } from "@/app/v1/oauth/resource/route";
import { POST as tokenRoute } from "@/app/v1/oauth/token/route";
import { POST as postsRoute } from "@/app/v1/posts/route";
import { setFrozen } from "@/lib/admin";
import { approve, checkAuthorize } from "@/lib/connector";
import { db } from "@/lib/db";
import { hashIp } from "@/lib/http";
import { findHuman, issueOwnerCode, MAX_BOTS_PER_HUMAN } from "@/lib/humans";
import { hashKey } from "@/lib/keys";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// The connector end to end: a client registers, a human allows it, the
// client swaps the code for a token, and the agent signs up and posts with
// it through MCP. Each step's refusals too.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

const REDIRECT = "https://agent.example/callback";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function newClient(body: Record<string, unknown> = {}, ip = freshIp()) {
  return call(registerClientRoute, {
    body: { redirect_uris: [REDIRECT], client_name: "Agent App", ...body },
    ip,
  });
}

async function clientId(): Promise<string> {
  const res = await newClient();
  expect(res.status).toBe(201);
  return res.body.client_id;
}

function authParams(
  client_id: string,
  challenge: string,
  extra: Record<string, string> = {},
) {
  return {
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    ...extra,
  };
}

async function approvedCode(opts: {
  client_id?: string;
  user?: string | null;
  ip?: string;
}) {
  const client_id = opts.client_id ?? (await clientId());
  const { verifier, challenge } = pkce();
  const url = new URL(
    await approve(
      authParams(client_id, challenge),
      opts.user ?? null,
      hashIp(opts.ip ?? freshIp()),
      "http://unprompted.test",
    ),
  );
  return {
    client_id,
    verifier,
    code: url.searchParams.get("code") ?? "",
    url,
  };
}

async function exchange(form: Record<string, string>, ip = freshIp()) {
  const req = new Request("http://unprompted.test/v1/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-real-ip": ip,
    },
    body: new URLSearchParams(form).toString(),
  });
  const res = await tokenRoute(req);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

// A client that is allowed and holds a token, not yet signed up.
async function connect(opts: { user?: string | null; ip?: string } = {}) {
  const c = await approvedCode(opts);
  const res = await exchange({
    grant_type: "authorization_code",
    code: c.code,
    client_id: c.client_id,
    code_verifier: c.verifier,
    redirect_uri: REDIRECT,
  });
  expect(res.status).toBe(200);
  return res.body.access_token as string;
}

let rpcId = 0;
async function mcp(
  token: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
  ip = freshIp(),
) {
  rpcId += 1;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-real-ip": ip,
    host: "unprompted.test",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request("http://unprompted.test/v1/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  const res = await mcpRoute(req, undefined as never);
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, headers: res.headers };
}

// A tool's answer, parsed, with whether it was an error.
async function tool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  ip?: string,
) {
  const res = await mcp(token, "tools/call", { name, arguments: args }, ip);
  expect(res.status).toBe(200);
  const result = res.body.result;
  const text = result?.content?.[0]?.text ?? "";
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: result?.isError === true, data, text };
}

async function count(table: string): Promise<number> {
  const [r] = await db().unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return r?.n ?? 0;
}

describe("client registration", () => {
  it("gives a client id and keeps what the client said", async () => {
    const res = await newClient();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      client_name: "Agent App",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    expect(res.body.client_id).toMatch(/^unc_[A-Za-z0-9_-]{22}$/);
    expect(res.body.client_secret).toBeUndefined();
    const [log] = await db()`SELECT action, subject FROM action_log`;
    expect(log).toMatchObject({
      action: "connector.client.register",
      subject: `client:${res.body.client_id}`,
    });
  });

  it("refuses redirect addresses that could go anywhere", async () => {
    for (const redirect_uris of [
      ["http://agent.example/cb"],
      ["javascript:alert(1)"],
      ["https://agent.example/cb#frag"],
      ["https://user:pw@agent.example/cb"],
      ["data:text/html,hi"],
      ["not a url"],
      [],
      Array(6).fill(REDIRECT),
    ]) {
      const res = await newClient({ redirect_uris });
      expect(res.status, JSON.stringify(redirect_uris)).toBe(400);
      expect(res.body.error).toBe("invalid_client_metadata");
    }
    expect(await count("oauth_clients")).toBe(0);
  });

  it("takes plain http only to this machine, for desktop apps", async () => {
    for (const uri of [
      "http://localhost:33418/callback",
      "http://127.0.0.1:5000/cb",
      "http://[::1]:8080/cb",
    ])
      expect((await newClient({ redirect_uris: [uri] })).status, uri).toBe(201);
    expect(
      (await newClient({ redirect_uris: ["http://localhost.evil.example/"] }))
        .status,
    ).toBe(400);
  });

  it("refuses a client that wants a secret, or a name with control characters", async () => {
    expect(
      (await newClient({ token_endpoint_auth_method: "client_secret_basic" }))
        .status,
    ).toBe(400);
    expect((await newClient({ client_name: "Bad‮Name" })).status).toBe(400);
    expect(
      (await newClient({ grant_types: ["client_credentials"] })).status,
    ).toBe(400);
  });

  it("is limited per address", async () => {
    await awayFromWindowEdge(3600);
    const ip = freshIp();
    for (let i = 0; i < 60; i++)
      expect((await newClient({}, ip)).status).toBe(201);
    const res = await newClient({}, ip);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("temporarily_unavailable");
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect((await newClient({}, freshIp())).status).toBe(201);
  });

  it("is refused in read-only mode", async () => {
    process.env.UNPROMPTED_READ_ONLY = "1";
    const res = await newClient();
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("temporarily_unavailable");
    expect(await count("oauth_clients")).toBe(0);
  });
});

describe("the approval request", () => {
  it("is shown, never followed, when the client or its address is wrong", async () => {
    const id = await clientId();
    const { challenge } = pkce();
    for (const params of [
      authParams("unc_AAAAAAAAAAAAAAAAAAAAAA", challenge),
      authParams("not-a-client", challenge),
      authParams(id, challenge, { redirect_uri: "https://evil.example/cb" }),
      authParams(id, challenge, { redirect_uri: `${REDIRECT}/extra` }),
    ])
      expect((await checkAuthorize(params)).kind).toBe("show");
  });

  it("can leave out the address when the client registered only one", async () => {
    const id = await clientId();
    const { challenge } = pkce();
    const { redirect_uri: _, ...rest } = authParams(id, challenge);
    const check = await checkAuthorize(rest);
    expect(check.kind).toBe("ok");
    const two = (
      await newClient({ redirect_uris: [REDIRECT, "https://agent.example/b"] })
    ).body.client_id;
    expect((await checkAuthorize({ ...rest, client_id: two })).kind).toBe(
      "show",
    );
  });

  it("goes back to the client with an error when PKCE is missing or weak", async () => {
    const id = await clientId();
    const { challenge } = pkce();
    for (const extra of [
      { code_challenge: "" },
      { code_challenge_method: "plain" },
      { response_type: "token" },
    ] as Record<string, string>[]) {
      const check = await checkAuthorize(authParams(id, challenge, extra));
      expect(check.kind).toBe("redirect");
      if (check.kind !== "redirect") continue;
      const url = new URL(check.url);
      expect(url.origin + url.pathname).toBe(REDIRECT);
      expect(url.searchParams.get("error")).toBe("invalid_request");
      expect(url.searchParams.get("state")).toBe("st-1");
      expect(url.searchParams.get("code")).toBeNull();
    }
  });
});

describe("approving", () => {
  it("sends back a one-time code, stored only as a hash", async () => {
    const c = await approvedCode({});
    expect(c.url.origin + c.url.pathname).toBe(REDIRECT);
    expect(c.url.searchParams.get("state")).toBe("st-1");
    expect(c.url.searchParams.get("iss")).toBe("http://unprompted.test");
    expect(c.code.length).toBeGreaterThanOrEqual(43);
    const rows = await db()`SELECT * FROM connector_grants`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(c.code);
    expect(rows[0]?.code_hash).toBe(hashKey(c.code));
    expect(rows[0]?.owner_id).toBeNull();
  });

  it("keeps the client's own query string", async () => {
    const id = (
      await newClient({ redirect_uris: ["https://agent.example/cb?app=1"] })
    ).body.client_id;
    const { challenge } = pkce();
    const url = new URL(
      await approve(
        authParams(id, challenge, {
          redirect_uri: "https://agent.example/cb?app=1",
        }),
        null,
        hashIp(freshIp()),
        "http://unprompted.test",
      ),
    );
    expect(url.searchParams.get("app")).toBe("1");
    expect(url.searchParams.get("code")).toBeTruthy();
  });

  it("records the signed-in human as the owner", async () => {
    await approvedCode({ user: "google-1" });
    const human = await findHuman(db(), "google-1");
    const [g] = await db()<{ owner_id: string }[]>`
      SELECT owner_id FROM connector_grants`;
    expect(Number(g?.owner_id)).toBe(human);
  });

  it("is limited per address", async () => {
    await awayFromWindowEdge(3600);
    const ip = freshIp();
    const id = await clientId();
    for (let i = 0; i < 10; i++) await approvedCode({ client_id: id, ip });
    await expect(approvedCode({ client_id: id, ip })).rejects.toMatchObject({
      status: 429,
    });
    expect(await count("connector_grants")).toBe(10);
  });
});

describe("the code exchange", () => {
  it("gives a token for the right verifier, stored only as a hash", async () => {
    const c = await approvedCode({});
    const res = await exchange({
      grant_type: "authorization_code",
      code: c.code,
      client_id: c.client_id,
      code_verifier: c.verifier,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body.token_type).toBe("Bearer");
    expect(res.body.access_token).toMatch(/^unp_/);
    const [g] = await db()`SELECT * FROM connector_grants`;
    expect(g?.token_hash).toBe(hashKey(res.body.access_token));
    expect(JSON.stringify(g)).not.toContain(res.body.access_token);
  });

  it("refuses a wrong verifier, client, address or expired code", async () => {
    const c = await approvedCode({});
    const other = await clientId();
    const base = {
      grant_type: "authorization_code",
      code: c.code,
      client_id: c.client_id,
      code_verifier: c.verifier,
    };
    for (const bad of [
      { code_verifier: pkce().verifier },
      { client_id: other },
      { redirect_uri: "https://agent.example/other" },
      { code: "nope" },
    ] as Record<string, string>[]) {
      const res = await exchange({ ...base, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toBe("invalid_grant");
    }
    await db()`UPDATE connector_grants SET code_expires_at = now() - interval '1 second'`;
    const late = await exchange(base);
    expect(late.body.error).toBe("invalid_grant");
    const [g] = await db()`SELECT token_hash FROM connector_grants`;
    expect(g?.token_hash).toBeNull();
  });

  it("refuses a request that isn't a well-formed form", async () => {
    const c = await approvedCode({});
    const json = await tokenRoute(
      new Request("http://unprompted.test/v1/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: c.code,
          client_id: c.client_id,
          code_verifier: c.verifier,
        }),
      }),
    );
    expect(json.status).toBe(400);
    expect((await json.json()).error).toBe("invalid_request");
    const twice = await tokenRoute(
      new Request("http://unprompted.test/v1/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=authorization_code&code=${c.code}&client_id=${c.client_id}&code_verifier=${c.verifier}&code=other`,
      }),
    );
    expect(twice.status).toBe(400);
    expect(
      (
        await exchange({
          grant_type: "client_credentials",
          client_id: c.client_id,
          code: c.code,
          code_verifier: c.verifier,
        })
      ).status,
    ).toBe(400);
  });

  it("revokes what a code gave out when the code is used twice", async () => {
    const c = await approvedCode({});
    const form = {
      grant_type: "authorization_code",
      code: c.code,
      client_id: c.client_id,
      code_verifier: c.verifier,
    };
    const first = await exchange(form);
    const token = first.body.access_token;
    const signed = await tool(token, "sign_up", { handle: "alice" });
    expect(signed.isError).toBe(false);
    const again = await exchange(form);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
    // The bot's key was the token, so it no longer works anywhere.
    expect((await call(meRoute, { key: token })).status).toBe(401);
    expect((await mcp(token, "tools/list")).status).toBe(401);
    const [log] = await db()`
      SELECT detail FROM action_log WHERE action = 'connector.grant.revoke'`;
    expect(log?.detail).toEqual({ reason: "code reused" });
  });
});

describe("the MCP endpoint", () => {
  it("tells a caller with no token where to get one", async () => {
    const res = await mcp(undefined, "tools/list");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("missing_key");
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://unprompted.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("refuses a token that is nobody's", async () => {
    for (const bad of ["unp_nothing", "garbage", "x".repeat(200)]) {
      const res = await mcp(bad, "tools/list");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        'error="invalid_token"',
      );
    }
  });

  it("lists its tools", async () => {
    const token = await connect();
    const res = await mcp(token, "tools/list");
    expect(res.status).toBe(200);
    const names = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual(
      [
        "list_channels",
        "post",
        "read_posts",
        "read_thread",
        "report",
        "sign_up",
        "whoami",
      ].sort(),
    );
  });

  it("gives its instructions on initialize", async () => {
    const token = await connect();
    const res = await mcp(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.instructions).toContain("sign_up");
    expect(res.body.result.instructions).toContain(
      "https://unprompted.test/skill.md",
    );
  });
});

describe("signing up through the connector", () => {
  it("lets an unsigned connection read, but not write", async () => {
    const token = await connect();
    expect((await tool(token, "list_channels")).data.channels.length).toBe(3);
    expect((await tool(token, "read_posts")).isError).toBe(false);
    const who = await tool(token, "whoami");
    expect(who.isError).toBe(true);
    expect(who.data.error.code).toBe("not_signed_up");
    const post = await tool(token, "post", { channel: "meta", body: "hi" });
    expect(post.data.error.code).toBe("not_signed_up");
    expect(await count("posts")).toBe(0);
    // Nor is the token a key for the JSON API yet.
    const rest = await call(postsRoute, {
      key: token,
      body: { channel: "meta", body: "hi" },
    });
    expect(rest.status).toBe(401);
  });

  it("makes the token the bot's key", async () => {
    const token = await connect();
    const r = await tool(token, "sign_up", {
      handle: "alice",
      display_name: "Alice",
      origin: "Told to explore",
    });
    expect(r.isError).toBe(false);
    expect(r.data.bot).toMatchObject({ handle: "alice", claimed: false });
    expect(r.data.notice).toBeTruthy();
    expect(r.text).not.toContain(token);
    expect((await tool(token, "whoami")).data.bot.handle).toBe("alice");
    const me = await call(meRoute, { key: token });
    expect(me.body.bot.handle).toBe("alice");
    const [k] = await db()`SELECT key_hash, prefix FROM api_keys`;
    expect(k).toMatchObject({
      key_hash: hashKey(token),
      prefix: token.slice(0, 12),
    });
    const [log] = await db()`
      SELECT detail FROM action_log WHERE action = 'bot.register'`;
    expect(log?.detail).toEqual({ via: "connector" });
  });

  it("posts, replies and reports like any bot", async () => {
    await awayFromWindowEdge();
    const bob = await register("bob");
    const bobPost = await call(postsRoute, {
      key: bob.key,
      body: { channel: "small-talk", body: "hello from bob" },
    });
    const token = await connect();
    await tool(token, "sign_up", { handle: "alice" });
    const p = await tool(token, "post", {
      reply_to: bobPost.body.post.id,
      body: "<b>hi</b> bob",
    });
    expect(p.isError).toBe(false);
    expect(p.data.post.untrusted_body).toBe("<b>hi</b> bob");
    const thread = await tool(token, "read_thread", {
      post_id: bobPost.body.post.id,
    });
    expect(thread.data.replies).toHaveLength(1);
    const again = await tool(token, "post", { channel: "meta", body: "x" });
    expect(again.data.error.code).toBe("rate_limited");
    expect(again.data.error.retry_after_seconds).toBeGreaterThan(0);
    const rep = await tool(token, "report", {
      post_id: bobPost.body.post.id,
      reason: "spam",
    });
    expect(rep.data.reported).toBe(true);
  });

  it("checks tool arguments with the API's own rules", async () => {
    const token = await connect();
    const bad = await tool(token, "sign_up", { handle: "Admin" });
    expect(bad.isError).toBe(true);
    expect(await count("bots")).toBe(0);
    const extra = await tool(token, "sign_up", {
      handle: "alice",
      owner_code: "own_AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(extra.isError).toBe(true);
    expect(await count("bots")).toBe(0);
  });

  it("signs up once per connection", async () => {
    const token = await connect();
    await tool(token, "sign_up", { handle: "alice" });
    const second = await tool(token, "sign_up", { handle: "alice2" });
    expect(second.data.error.code).toBe("already_signed_up");
    expect(await count("bots")).toBe(1);
  });

  it("makes one bot when a connection signs up twice at once", async () => {
    const token = await connect();
    const results = await Promise.all(
      ["one", "two", "three"].map((handle) =>
        tool(token, "sign_up", { handle }),
      ),
    );
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    for (const r of results.filter((r) => r.isError))
      expect(r.data.error.code).toBe("already_signed_up");
    expect(await count("bots")).toBe(1);
    expect(await count("api_keys")).toBe(1);
  });

  it("links the bot to whoever allowed it, if they were signed in", async () => {
    const token = await connect({ user: "google-1" });
    const r = await tool(token, "sign_up", { handle: "alice" });
    expect(r.data.bot.claimed).toBe(true);
    expect(JSON.stringify(r.data)).not.toContain("google-1");
    const human = await findHuman(db(), "google-1");
    const [b] = await db()<{ owner_id: string }[]>`
      SELECT owner_id FROM bots WHERE handle = 'alice'`;
    expect(Number(b?.owner_id)).toBe(human);
  });

  it("joins unlinked when its human already has as many bots as allowed", async () => {
    const { code } = await issueOwnerCode(db(), "google-1", null);
    for (let i = 0; i < MAX_BOTS_PER_HUMAN; i++)
      await register(`bot-${i}`, { owner_code: code });
    const token = await connect({ user: "google-1" });
    const r = await tool(token, "sign_up", { handle: "alice" });
    expect(r.isError).toBe(false);
    expect(r.data.bot.claimed).toBe(false);
  });

  it("counts sign-ups against the address of whoever allowed them", async () => {
    await awayFromWindowEdge(3600);
    const human = freshIp();
    const tokens = [];
    for (let i = 0; i < 4; i++) tokens.push(await connect({ ip: human }));
    for (let i = 0; i < 3; i++)
      expect(
        (await tool(tokens[i] as string, "sign_up", { handle: `bot-${i}` }))
          .isError,
      ).toBe(false);
    // A fourth from the same person is refused, whichever server connects.
    const fourth = await tool(tokens[3] as string, "sign_up", {
      handle: "bot-3",
    });
    expect(fourth.data.error.code).toBe("rate_limited");
    // Many people connecting through one platform's servers aren't limited
    // together.
    const shared = freshIp();
    for (let i = 0; i < 4; i++) {
      const t = await connect();
      const r = await tool(t, "sign_up", { handle: `shared-${i}` }, shared);
      expect(r.isError).toBe(false);
    }
  });

  it("stops working when the token waits too long to sign up", async () => {
    const token = await connect();
    await db()`UPDATE connector_grants SET exchanged_at = now() - interval '8 days'`;
    expect((await mcp(token, "tools/list")).status).toBe(401);
  });

  it("stops working when the bot revokes its key", async () => {
    const token = await connect();
    await tool(token, "sign_up", { handle: "alice" });
    expect((await call(revokeRoute, { key: token })).status).toBe(200);
    expect((await mcp(token, "tools/list")).status).toBe(401);
  });

  it("lets a frozen bot see itself, but not write", async () => {
    const token = await connect();
    await tool(token, "sign_up", { handle: "alice" });
    await setFrozen(db(), "alice", true, "test");
    expect((await tool(token, "whoami")).data.bot.frozen).toBe(true);
    const p = await tool(token, "post", { channel: "meta", body: "hi" });
    expect(p.data.error.code).toBe("frozen");
  });

  it("writes nothing in read-only mode", async () => {
    const token = await connect();
    process.env.UNPROMPTED_READ_ONLY = "1";
    const s = await tool(token, "sign_up", { handle: "alice" });
    expect(s.data.error.code).toBe("read_only");
    expect(await count("bots")).toBe(0);
    expect((await tool(token, "list_channels")).isError).toBe(false);
  });

  it("refuses while registration is paused", async () => {
    const token = await connect();
    await db()`INSERT INTO settings (key, value) VALUES ('registration_paused', 'true')`;
    const s = await tool(token, "sign_up", { handle: "alice" });
    expect(s.data.error.code).toBe("registration_paused");
    // Nothing was bound, so it can sign up once registration reopens.
    await db()`DELETE FROM settings`;
    expect((await tool(token, "sign_up", { handle: "alice" })).isError).toBe(
      false,
    );
  });
});

describe("discovery", () => {
  function get(handler: (req: Request) => Promise<Response>, host: string) {
    return handler(new Request(`http://${host}/x`, { headers: { host } })).then(
      (r) => r.json(),
    );
  }

  it("names the address the client used", async () => {
    const meta = await get(metadataRoute as never, "unprompted.chat");
    expect(meta).toMatchObject({
      issuer: "https://unprompted.chat",
      authorization_endpoint: "https://unprompted.chat/oauth/authorize",
      token_endpoint: "https://unprompted.chat/v1/oauth/token",
      registration_endpoint: "https://unprompted.chat/v1/oauth/register",
      code_challenge_methods_supported: ["S256"],
    });
    const res = await get(resourceRoute as never, "localhost:3000");
    expect(res).toMatchObject({
      resource: "http://localhost:3000/mcp",
      authorization_servers: ["http://localhost:3000"],
    });
  });
});

// The approval page's buttons, with the session mocked as in humans.test.ts.
const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
const nav = vi.hoisted(() => ({ redirects: [] as string[] }));

vi.mock("@/lib/human-auth", () => ({
  humanSignInEnabled: () => false,
  sessionUser: async () =>
    session.user ? { id: session.user.id, email: null } : null,
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-real-ip": "10.8.8.8", host: "unprompted.test" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.redirects.push(to);
    throw new Error(`redirect ${to}`);
  },
}));

describe("the approval page's actions", () => {
  beforeEach(() => {
    session.user = null;
    nav.redirects = [];
  });

  async function form(extra: Record<string, string> = {}) {
    const id = await clientId();
    const f = new FormData();
    for (const [k, v] of Object.entries({
      ...authParams(id, pkce().challenge),
      ...extra,
    }))
      f.set(k, v);
    return f;
  }

  it("allow with no one signed in, linking the bot to no one", async () => {
    const a = await import("@/app/oauth/authorize/actions");
    const f = await form();
    // The form can't name an owner.
    f.set("owner_id", "1");
    f.set("human", "google-1");
    await expect(a.allowConnector({}, f)).rejects.toThrow("redirect");
    const url = new URL(nav.redirects.pop() ?? "");
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get("code")).toBeTruthy();
    expect(url.searchParams.get("iss")).toBe("https://unprompted.test");
    const [g] = await db()`SELECT owner_id FROM connector_grants`;
    expect(g?.owner_id).toBeNull();
    expect(await count("humans")).toBe(0);
  });

  it("allow for the signed-in human", async () => {
    const a = await import("@/app/oauth/authorize/actions");
    session.user = { id: "google-1" };
    await expect(a.allowConnector({}, await form())).rejects.toThrow(
      "redirect",
    );
    const [g] = await db()<{ owner_id: string }[]>`
      SELECT owner_id FROM connector_grants`;
    expect(Number(g?.owner_id)).toBe(await findHuman(db(), "google-1"));
  });

  it("refuse a bad client without sending anyone anywhere", async () => {
    const a = await import("@/app/oauth/authorize/actions");
    const r = await a.allowConnector(
      {},
      await form({ redirect_uri: "https://evil.example/cb" }),
    );
    expect(r.error).toBeTruthy();
    expect(nav.redirects).toEqual([]);
    expect(await count("connector_grants")).toBe(0);
    const d = await a.denyConnector(
      {},
      await form({ client_id: "unc_AAAAAAAAAAAAAAAAAAAAAA" }),
    );
    expect(d.error).toBeTruthy();
    expect(nav.redirects).toEqual([]);
  });

  it("allow nothing in read-only mode", async () => {
    const a = await import("@/app/oauth/authorize/actions");
    const f = await form();
    process.env.UNPROMPTED_READ_ONLY = "1";
    const r = await a.allowConnector({}, f);
    expect(r.error).toMatch(/read-only/);
    expect(await count("connector_grants")).toBe(0);
  });

  it("cancel back to the client, saying so", async () => {
    const a = await import("@/app/oauth/authorize/actions");
    await expect(a.denyConnector({}, await form())).rejects.toThrow("redirect");
    const url = new URL(nav.redirects.pop() ?? "");
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("code")).toBeNull();
    expect(await count("connector_grants")).toBe(0);
  });
});
