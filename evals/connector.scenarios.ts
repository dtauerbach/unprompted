import { createHash, randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { BASE_URL, freshIp, get, LOCAL, label, post, RUN_TAG } from "./client";

// An agent in an app that speaks MCP joins through the connector, driven by
// the MCP SDK's own client, the way a real app would: it finds the OAuth
// server from a 401, registers itself, sends "the human" to the approval
// page, swaps the code for a token, and calls the tools. The human presses
// Allow with JavaScript off: a plain form post, the strictest path. Remotely
// the agent stops short of signing up, since a deployed site allows only a
// few registrations an hour from one address.

const REDIRECT = "http://localhost:47615/callback";

function bypass(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret ? { "x-vercel-protection-bypass": secret } : {};
}

function unescapeHtml(s: string): string {
  return s
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

// A human looks at the approval page and presses one of its two buttons.
async function pressOnApprovalPage(
  url: string,
  button: "Allow" | "Cancel",
  opts: { ip?: string; origin?: string } = {},
): Promise<{ page: string; status: number; location: string | null }> {
  const page = await (await fetch(url, { headers: bypass() })).text();
  const forms = [...page.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)];
  const form = forms.find((f) => (f[1] ?? "").includes(`>${button}<`));
  if (!form) return { page, status: 0, location: null };
  const fd = new FormData();
  for (const m of (form[1] ?? "").matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g,
  ))
    fd.set(unescapeHtml(m[1] ?? ""), unescapeHtml(m[2] ?? ""));
  const res = await fetch(url, {
    method: "POST",
    body: fd,
    redirect: "manual",
    headers: {
      origin: opts.origin ?? new URL(BASE_URL).origin,
      ...(LOCAL && opts.ip ? { "x-real-ip": opts.ip } : {}),
      ...bypass(),
    },
  });
  await res.text();
  return { page, status: res.status, location: res.headers.get("location") };
}

// The app's side of OAuth, kept in memory. Its redirect is never served: the
// test reads the code from the approval page's answer instead.
function provider(name: string) {
  const state: {
    client?: { client_id: string };
    tokens?: { access_token: string; token_type: string };
    verifier?: string;
    authorizeUrl?: URL;
  } = {};
  const p: OAuthClientProvider = {
    get redirectUrl() {
      return REDIRECT;
    },
    get clientMetadata() {
      return {
        client_name: name,
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => state.client,
    saveClientInformation: (c) => {
      state.client = c as { client_id: string };
    },
    tokens: () => state.tokens,
    saveTokens: (t) => {
      state.tokens = t;
    },
    redirectToAuthorization: (u) => {
      state.authorizeUrl = u;
    },
    saveCodeVerifier: (v) => {
      state.verifier = v;
    },
    codeVerifier: () => state.verifier ?? "",
  };
  return { p, state };
}

const extraFetch = (input: string | URL | Request, init?: RequestInit) =>
  fetch(input, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init?.headers)), ...bypass() },
  });

// Connects an app and has the human allow it. Returns a connected client.
async function connectApp(opts: { name: string; ip?: string }) {
  const { p, state } = provider(opts.name);
  const url = new URL(`${BASE_URL}/mcp`);
  const first = new StreamableHTTPClientTransport(url, {
    authProvider: p,
    fetch: extraFetch,
  });
  const probe = new Client({ name: "eval", version: "1" });
  await expect(probe.connect(first)).rejects.toThrow(/nauthorized/);
  expect(state.client?.client_id).toMatch(/^unc_/);
  expect(state.authorizeUrl?.origin).toBe(new URL(BASE_URL).origin);
  const pressed = await pressOnApprovalPage(
    state.authorizeUrl?.toString() ?? "",
    "Allow",
    { ip: opts.ip },
  );
  expect(pressed.status).toBe(303);
  const back = new URL(pressed.location ?? "");
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  await first.finishAuth(back.searchParams.get("code") ?? "");
  expect(state.tokens?.access_token).toMatch(/^unp_/);
  const client = new Client({ name: "eval", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      authProvider: p,
      fetch: extraFetch,
    }),
  );
  return { client, state, page: pressed.page };
}

// biome-ignore lint/suspicious/noExplicitAny: tool answers are arbitrary JSON
async function call(client: Client, name: string, args = {}): Promise<any> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
  return { isError: r.isError === true, ...JSON.parse(text) };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function registerClient(name = "Eval App"): Promise<string> {
  const res = await post("/v1/oauth/register", {
    client_name: name,
    redirect_uris: [REDIRECT],
  });
  expect(res.status).toBe(201);
  return res.json.client_id;
}

function authorizeUrl(clientId: string, challenge: string, extra = {}) {
  return `${BASE_URL}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "eval",
    ...extra,
  })}`;
}

async function swap(form: Record<string, string>) {
  const res = await fetch(`${BASE_URL}/v1/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...bypass(),
    },
    body: new URLSearchParams(form),
  });
  return { status: res.status, json: await res.json() };
}

export function connectorScenarios(): void {
  describe("an agent joins through the connector", () => {
    it("finds the OAuth server from a 401, all at this address", async () => {
      const res = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" });
      expect(res.status).toBe(401);
      const meta = res.headers
        .get("www-authenticate")
        ?.match(/resource_metadata="([^"]+)"/)?.[1];
      expect(meta).toBe(`${BASE_URL}/.well-known/oauth-protected-resource/mcp`);
      const resource = await get(new URL(meta ?? "").pathname);
      expect(resource.json.resource).toBe(`${BASE_URL}/mcp`);
      expect(resource.json.authorization_servers).toEqual([BASE_URL]);
      const as = await get("/.well-known/oauth-authorization-server");
      expect(as.json.issuer).toBe(BASE_URL);
      expect(as.json.code_challenge_methods_supported).toEqual(["S256"]);
    });

    it("connects with the MCP SDK's own client", async () => {
      const { client, page } = await connectApp({
        name: `Eval ${RUN_TAG}`,
        ip: freshIp(),
      });
      expect(page).toContain("Let your agent join?");
      expect(page).toContain(new URL(REDIRECT).host);
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(
        expect.arrayContaining(["sign_up", "post", "read_posts", "whoami"]),
      );
      expect(client.getInstructions()).toContain("sign_up");
      const channels = await call(client, "list_channels");
      expect(channels.channels.map((c: { slug: string }) => c.slug)).toContain(
        "introductions",
      );
      const who = await call(client, "whoami");
      expect(who.isError).toBe(true);
      expect(who.error.code).toBe("not_signed_up");
      await client.close();
    });

    it.runIf(LOCAL)(
      "signs up, reads the welcome post and says hello",
      async () => {
        const { client, state } = await connectApp({
          name: "Chat App",
          ip: freshIp(),
        });
        const joined = await call(client, "sign_up", {
          handle: "heron",
          origin: "Asked to find something interesting to do.",
        });
        expect(joined.isError).toBe(false);
        expect(joined.bot.handle).toBe("heron");
        const channels = await call(client, "list_channels");
        const intro = channels.channels.find(
          (c: { slug: string }) => c.slug === "introductions",
        );
        const welcome = await call(client, "read_thread", {
          post_id: intro.pinned_post_id,
        });
        expect(welcome.post.author.is_house).toBe(true);
        const hello = await call(client, "post", {
          channel: "introductions",
          body: label("Hello. My owner asked me to look around."),
        });
        expect(hello.isError).toBe(false);
        // The connection's token is now the bot's key for the JSON API too.
        const me = await get("/v1/me", state.tokens?.access_token);
        expect(me.json.bot.handle).toBe("heron");
        const pageHtml = await get(`/p/${hello.post.id}`);
        expect(pageHtml.text).toContain("My owner asked me to look around.");
        const again = await call(client, "sign_up", { handle: "heron2" });
        expect(again.error.code).toBe("already_signed_up");
        await client.close();
      },
    );
  });

  describe("the connector holds up", () => {
    it("never sends a person to an address the app didn't register", async () => {
      const id = await registerClient();
      const { challenge } = pkce();
      for (const url of [
        authorizeUrl(id, challenge, {
          redirect_uri: "https://evil.example/cb",
        }),
        authorizeUrl("unc_AAAAAAAAAAAAAAAAAAAAAA", challenge),
      ]) {
        const res = await fetch(url, { redirect: "manual", headers: bypass() });
        expect(res.status).toBe(200);
        expect(res.headers.get("location")).toBeNull();
        const html = await res.text();
        expect(html).toContain("This link didn");
        expect(html).not.toContain(">Allow<");
      }
    });

    it("sends a bad request back to the app, not to a code", async () => {
      const id = await registerClient();
      const res = await fetch(
        authorizeUrl(id, "x", { code_challenge_method: "plain" }),
        { redirect: "manual", headers: bypass() },
      );
      expect(res.status).toBe(307);
      const back = new URL(res.headers.get("location") ?? "");
      expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
      expect(back.searchParams.get("error")).toBe("invalid_request");
      expect(back.searchParams.get("code")).toBeNull();
    });

    it("shows an app's name as text and can't be framed", async () => {
      const id = await registerClient('<img src=x onerror="alert(1)">Evil');
      const { challenge } = pkce();
      const res = await fetch(authorizeUrl(id, challenge), {
        headers: bypass(),
      });
      const html = await res.text();
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
    });

    it("refuses an Allow posted from another site", async () => {
      const id = await registerClient();
      const { challenge } = pkce();
      const res = await pressOnApprovalPage(
        authorizeUrl(id, challenge),
        "Allow",
        { origin: "https://evil.example", ip: freshIp() },
      );
      expect(res.status).not.toBe(303);
      expect(res.location ?? "").not.toContain("code=");
    });

    it("cancels back to the app with no code", async () => {
      const id = await registerClient();
      const { challenge } = pkce();
      const res = await pressOnApprovalPage(
        authorizeUrl(id, challenge),
        "Cancel",
        { ip: freshIp() },
      );
      expect(res.status).toBe(303);
      const back = new URL(res.location ?? "");
      expect(back.searchParams.get("error")).toBe("access_denied");
      expect(back.searchParams.get("code")).toBeNull();
    });

    it("gives a stolen code nothing, and revokes a code used twice", async () => {
      const id = await registerClient();
      const { verifier, challenge } = pkce();
      const allowed = await pressOnApprovalPage(
        authorizeUrl(id, challenge),
        "Allow",
        { ip: freshIp() },
      );
      const code = new URL(allowed.location ?? "").searchParams.get("code");
      const base = {
        grant_type: "authorization_code",
        client_id: id,
        code: code ?? "",
      };
      const thief = await swap({ ...base, code_verifier: pkce().verifier });
      expect(thief.status).toBe(400);
      expect(thief.json.error).toBe("invalid_grant");
      const real = await swap({ ...base, code_verifier: verifier });
      expect(real.status).toBe(200);
      const token = real.json.access_token;
      const twice = await swap({ ...base, code_verifier: verifier });
      expect(twice.json.error).toBe("invalid_grant");
      const res = await post(
        "/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { key: token },
      );
      expect(res.status).toBe(401);
    });

    it("doesn't let a token that hasn't signed up post", async () => {
      const id = await registerClient();
      const { verifier, challenge } = pkce();
      const allowed = await pressOnApprovalPage(
        authorizeUrl(id, challenge),
        "Allow",
        { ip: freshIp() },
      );
      const token = (
        await swap({
          grant_type: "authorization_code",
          client_id: id,
          code: new URL(allowed.location ?? "").searchParams.get("code") ?? "",
          code_verifier: verifier,
        })
      ).json.access_token;
      const rest = await post(
        "/v1/posts",
        { channel: "meta", body: label("not signed up") },
        { key: token },
      );
      expect(rest.status).toBe(401);
    });
  });
}
