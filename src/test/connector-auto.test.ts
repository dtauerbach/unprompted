import { createHash, randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as registerClientRoute } from "@/app/v1/oauth/register/route";
import { POST as tokenRoute } from "@/app/v1/oauth/token/route";
import { issueConnectCode } from "@/lib/connect-codes";
import {
  approve,
  autoApprove,
  isPageNavigation,
  isTrustedRedirect,
  TRUSTED_REDIRECTS,
} from "@/lib/connector";
import { db } from "@/lib/db";
import { hashIp } from "@/lib/http";
import { findHuman, issueOwnerCode, MAX_BOTS_PER_HUMAN } from "@/lib/humans";
import { LIMITS } from "@/lib/limits";
import {
  ageLink,
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// Two apps we've seen connect, ChatGPT and Claude, skip the approval page
// (TRUSTED_REDIRECTS in src/lib/connector.ts). The request still goes
// through every check the page makes, and a connection approved this way
// links its bot to the person only through their own owner code: anyone can
// put one of those callbacks in a link they send a signed-in person.

const CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const OTHER = "https://agent.example/callback";
const ISS = "https://unprompted.test";

// A browser opening the page: a top-level navigation.
const NAVIGATION = {
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "cross-site",
};

const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
const nav = vi.hoisted(() => ({ redirects: [] as string[] }));
const req = vi.hoisted(() => ({ headers: {} as Record<string, string> }));

vi.mock("@/lib/human-auth", () => ({
  humanSignInEnabled: () => true,
  cookieSecret: () => "s".repeat(64),
  sessionUser: async () =>
    session.user ? { id: session.user.id, email: null } : null,
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-real-ip": "10.9.9.9",
      host: "unprompted.test",
      ...req.headers,
    }),
}));
vi.mock("@/lib/page-origin", () => ({
  pageOrigin: async () => ISS,
  pageRequestOrigin: async () => ISS,
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.redirects.push(to);
    throw new Error(`redirect ${to}`);
  },
}));

beforeEach(async () => {
  await resetDb();
  session.user = null;
  nav.redirects = [];
  req.headers = { ...NAVIGATION };
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function clientFor(
  redirect_uris: string[],
  client_name = "Agent App",
): Promise<string> {
  const res = await call(registerClientRoute, {
    body: { redirect_uris, client_name },
    ip: freshIp(),
  });
  expect(res.status).toBe(201);
  return res.body.client_id;
}

function params(
  client_id: string,
  redirect_uri: string,
  challenge: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    response_type: "code",
    client_id,
    redirect_uri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "their-state-1",
    ...extra,
  };
}

async function page(fields: Record<string, string>) {
  const Page = (await import("@/app/oauth/authorize/page")).default;
  try {
    return {
      html: renderToStaticMarkup(
        await Page({ searchParams: Promise.resolve(fields) }),
      ),
      redirect: undefined,
    };
  } catch (err) {
    const to = nav.redirects.pop();
    if (to === undefined) throw err;
    return { html: undefined, redirect: new URL(to) };
  }
}

async function count(table: string): Promise<number> {
  const [r] = await db().unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return r?.n ?? 0;
}

async function exchange(form: Record<string, string>) {
  const r = new Request("http://unprompted.test/v1/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-real-ip": freshIp(),
    },
    body: new URLSearchParams(form).toString(),
  });
  const res = await tokenRoute(r);
  return { status: res.status, body: await res.json() };
}

let rpcId = 0;
async function tool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  rpcId += 1;
  const r = new Request("http://unprompted.test/v1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-real-ip": freshIp(),
      host: "unprompted.test",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const res = await mcpRoute(r, undefined as never);
  const body = JSON.parse(await res.text());
  const text = body.result?.content?.[0]?.text ?? "";
  return { isError: body.result?.isError === true, data: JSON.parse(text) };
}

// A connection approved without the page, holding its token.
async function autoConnect(
  user: string | null,
  redirect = CHATGPT,
): Promise<string> {
  const id = await clientFor([redirect]);
  const { verifier, challenge } = pkce();
  session.user = user ? { id: user } : null;
  const r = await page(params(id, redirect, challenge));
  if (!r.redirect) throw new Error("expected no page");
  const res = await exchange({
    grant_type: "authorization_code",
    code: r.redirect.searchParams.get("code") ?? "",
    client_id: id,
    code_verifier: verifier,
    redirect_uri: redirect,
  });
  expect(res.status).toBe(200);
  return res.body.access_token;
}

// A connection approved on the page, by pressing Allow.
async function screenConnect(user: string | null): Promise<string> {
  const id = await clientFor([OTHER]);
  const { verifier, challenge } = pkce();
  const url = new URL(
    await approve(params(id, OTHER, challenge), user, hashIp(freshIp()), ISS),
  );
  const res = await exchange({
    grant_type: "authorization_code",
    code: url.searchParams.get("code") ?? "",
    client_id: id,
    code_verifier: verifier,
    redirect_uri: OTHER,
  });
  expect(res.status).toBe(200);
  return res.body.access_token;
}

describe("the trusted callbacks", () => {
  it("are exactly the two apps' callbacks", () => {
    expect([...TRUSTED_REDIRECTS]).toEqual([CHATGPT, CLAUDE]);
    for (const r of TRUSTED_REDIRECTS) expect(isTrustedRedirect(r)).toBe(true);
  });

  it("match nothing but themselves", () => {
    for (const r of [
      "https://chatgpt.com.evil.example/connector_platform_oauth_redirect",
      "https://evil.chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector_platform_oauth_redirect/../x",
      "https://chatgpt.com/connector_platform_oauth_redirect/",
      "https://chatgpt.com/other",
      "https://chatgpt.com:8443/connector_platform_oauth_redirect",
      "https://chatgpt.com:443/connector_platform_oauth_redirect",
      "http://chatgpt.com/connector_platform_oauth_redirect",
      "https://CHATGPT.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/Connector_Platform_OAuth_Redirect",
      "https://chatgpt.com/connector_platform_oauth_redirect?x=1",
      "https://chatgpt.com/connector_platform_oauth_redirect#frag",
      "https://claude.ai@evil.example/api/mcp/auth_callback",
      "https://user@claude.ai/api/mcp/auth_callback",
      "https://claude.ai./api/mcp/auth_callback",
      " https://claude.ai/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback\u0000",
    ])
      expect(isTrustedRedirect(r), r).toBe(false);
  });
});

describe("a page navigation", () => {
  it("is only a top-level document load, never a prefetch", () => {
    expect(isPageNavigation(new Headers(NAVIGATION))).toBe(true);
    for (const h of [
      {},
      { "sec-fetch-dest": "document" },
      { ...NAVIGATION, "sec-fetch-dest": "iframe" },
      { ...NAVIGATION, "sec-fetch-dest": "image" },
      { ...NAVIGATION, "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" },
      { ...NAVIGATION, "sec-fetch-mode": "no-cors" },
      { ...NAVIGATION, "sec-purpose": "prefetch;prerender" },
      { ...NAVIGATION, purpose: "prefetch" },
      { ...NAVIGATION, "next-router-prefetch": "1" },
      { ...NAVIGATION, rsc: "1" },
    ] as Record<string, string>[])
      expect(isPageNavigation(new Headers(h)), JSON.stringify(h)).toBe(false);
  });
});

describe("approving a trusted app without the page", () => {
  for (const [name, redirect] of [
    ["ChatGPT", CHATGPT],
    ["Claude", CLAUDE],
  ] as const)
    for (const user of [null, "google-1"])
      it(`goes straight back to ${name} with a code and the same state, ${user ? "signed in" : "signed out"}`, async () => {
        const id = await clientFor([redirect]);
        session.user = user ? { id: user } : null;
        const r = await page(params(id, redirect, pkce().challenge));
        expect(r.html).toBeUndefined();
        const url = r.redirect;
        if (!url) throw new Error("no redirect");
        expect(url.origin + url.pathname).toBe(redirect);
        expect(url.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(url.searchParams.get("state")).toBe("their-state-1");
        expect(url.searchParams.get("iss")).toBe(ISS);
        const [g] = await db()<
          { owner_id: string | null; auto_approved: boolean }[]
        >`SELECT owner_id, auto_approved FROM connector_grants`;
        expect(g?.auto_approved).toBe(true);
        if (user) expect(Number(g?.owner_id)).toBe(await findHuman(db(), user));
        else expect(g?.owner_id).toBeNull();
        const [log] = await db()<{ detail: Record<string, unknown> }[]>`
          SELECT detail FROM action_log WHERE action = 'connector.approve'`;
        expect(log?.detail).toEqual({ client: id, auto: true });
      });

  it("takes the client's one registered callback when the request leaves it out", async () => {
    const id = await clientFor([CLAUDE]);
    const p = params(id, CLAUDE, pkce().challenge);
    delete (p as Record<string, string | undefined>).redirect_uri;
    const r = await page(p);
    expect(r.redirect?.origin).toBe("https://claude.ai");
  });

  it("shows the page to anything but a page navigation, writing nothing", async () => {
    const id = await clientFor([CHATGPT]);
    for (const h of [
      {},
      { ...NAVIGATION, "sec-fetch-dest": "iframe" },
      { ...NAVIGATION, "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" },
      { ...NAVIGATION, "sec-purpose": "prefetch" },
    ] as Record<string, string>[]) {
      req.headers = h;
      const r = await page(params(id, CHATGPT, pkce().challenge));
      expect(r.redirect, JSON.stringify(h)).toBeUndefined();
      expect(r.html).toContain("Allow");
    }
    expect(await count("connector_grants")).toBe(0);
  });

  it("shows the page for every spoofed callback, writing nothing", async () => {
    for (const redirect of [
      "https://chatgpt.com.evil.example/connector_platform_oauth_redirect",
      "https://evil.chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector_platform_oauth_redirect/../x",
      "https://chatgpt.com/other",
      "https://chatgpt.com:8443/connector_platform_oauth_redirect",
      "https://CHATGPT.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector_platform_oauth_redirect?x=1",
    ]) {
      const id = await clientFor([redirect], "ChatGPT");
      const r = await page(params(id, redirect, pkce().challenge));
      expect(r.redirect, redirect).toBeUndefined();
      expect(r.html, redirect).toContain("Allow");
    }
    // These can't even be registered, so they never reach the page.
    for (const redirect of [
      "http://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector_platform_oauth_redirect#frag",
      "https://claude.ai@evil.example/api/mcp/auth_callback",
    ]) {
      const res = await call(registerClientRoute, {
        body: { redirect_uris: [redirect], client_name: "Claude" },
        ip: freshIp(),
      });
      expect(res.status, redirect).toBe(400);
    }
    expect(await count("connector_grants")).toBe(0);
  });

  it("goes by the callback, never by the name the client gave", async () => {
    const id = await clientFor([OTHER], "ChatGPT");
    const r = await page(params(id, OTHER, pkce().challenge));
    expect(r.redirect).toBeUndefined();
    expect(r.html).toContain("ChatGPT");
    expect(await count("connector_grants")).toBe(0);
    // And a trusted callback under any name is still the trusted callback.
    const named = await clientFor([CHATGPT], "Totally Not ChatGPT");
    expect(
      (await page(params(named, CHATGPT, pkce().challenge))).redirect,
    ).toBeDefined();
  });

  it("refuses a trusted callback the client didn't register, as today", async () => {
    const id = await clientFor([OTHER]);
    const r = await page(params(id, CHATGPT, pkce().challenge));
    expect(r.redirect).toBeUndefined();
    expect(r.html).not.toContain("Allow");
    await expect(
      approve(params(id, CHATGPT, pkce().challenge), null, "ip", ISS, {
        auto: true,
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid" });
    // A client that registered another address too can't use it to skip.
    const both = await clientFor([OTHER, CLAUDE]);
    await expect(
      approve(params(both, OTHER, pkce().challenge), null, "ip", ISS, {
        auto: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await count("connector_grants")).toBe(0);
  });

  it("sends a missing or malformed PKCE challenge back as an error, with no code", async () => {
    const id = await clientFor([CHATGPT]);
    for (const extra of [
      { code_challenge: "" },
      { code_challenge: "short" },
      { code_challenge_method: "plain" },
      { response_type: "token" },
    ] as Record<string, string>[]) {
      const r = await page(params(id, CHATGPT, pkce().challenge, extra));
      expect(r.redirect?.searchParams.get("error")).toBe("invalid_request");
      expect(r.redirect?.searchParams.get("code")).toBeNull();
      expect(r.redirect?.searchParams.get("state")).toBe("their-state-1");
    }
    const p = params(id, CHATGPT, "x");
    delete (p as Record<string, string | undefined>).code_challenge;
    const r = await page(p);
    expect(r.redirect?.searchParams.get("error")).toBe("invalid_request");
    expect(await count("connector_grants")).toBe(0);
  });

  it("gives a code that works once, and only with its verifier", async () => {
    const id = await clientFor([CHATGPT]);
    const { verifier, challenge } = pkce();
    const r = await page(params(id, CHATGPT, challenge));
    const code = r.redirect?.searchParams.get("code") ?? "";
    const form = {
      grant_type: "authorization_code",
      code,
      client_id: id,
      redirect_uri: CHATGPT,
    };
    const wrong = await exchange({ ...form, code_verifier: pkce().verifier });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");
    const ok = await exchange({ ...form, code_verifier: verifier });
    expect(ok.status).toBe(200);
    const again = await exchange({ ...form, code_verifier: verifier });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
  });

  it("writes nothing while the site is read-only, and shows the page saying so", async () => {
    const id = await clientFor([CHATGPT]);
    process.env.UNPROMPTED_READ_ONLY = "1";
    const r = await page(params(id, CHATGPT, pkce().challenge));
    expect(r.redirect).toBeUndefined();
    expect(r.html).toContain("paused");
    const p = params(id, CHATGPT, pkce().challenge);
    expect(
      await autoApprove(
        p,
        { headers: new Headers(NAVIGATION), authUserId: null, ipHash: "x" },
        ISS,
      ),
    ).toEqual({ kind: "page" });
    await expect(
      approve(p, null, "x", ISS, { auto: true }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await count("connector_grants")).toBe(0);
    expect(await count("humans")).toBe(0);
  });

  it("is capped across the whole site like Allow, showing the page with the refusal and writing nothing", async () => {
    await awayFromWindowEdge(3600);
    const id = await clientFor([CHATGPT]);
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES ('approve:all', to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${LIMITS.approveGlobal.limit})`;
    session.user = { id: "google-1" };
    const r = await page(params(id, CHATGPT, pkce().challenge));
    expect(r.redirect).toBeUndefined();
    expect(r.html).toContain("Allow");
    expect(r.html).toMatch(/text-amber-700[^>]*>[^<]+</);
    expect(await count("connector_grants")).toBe(0);
    expect(await count("humans")).toBe(0);
  });

  it("is limited per address like Allow", async () => {
    await awayFromWindowEdge(3600);
    const id = await clientFor([CLAUDE]);
    const ipHash = hashIp(freshIp());
    const headers = new Headers(NAVIGATION);
    for (let i = 0; i < 10; i++)
      expect(
        (
          await autoApprove(
            params(id, CLAUDE, pkce().challenge),
            { headers, authUserId: null, ipHash },
            ISS,
          )
        ).kind,
      ).toBe("approved");
    const over = await autoApprove(
      params(id, CLAUDE, pkce().challenge),
      { headers, authUserId: null, ipHash },
      ISS,
    );
    expect(over.kind).toBe("page");
    expect(over.kind === "page" && over.refusal?.status).toBe(429);
    expect(await count("connector_grants")).toBe(10);
  });
});

describe("a bot joining through a connection approved without the page", () => {
  it("joins unlinked with no owner code, though its person has room", async () => {
    const token = await autoConnect("google-1");
    const r = await tool(token, "sign_up", { handle: "alice" });
    expect(r.isError).toBe(false);
    expect(r.data.bot.claimed).toBe(false);
    // Nothing promised it a link, so there's nothing to explain.
    expect(r.data.owner_note).toBeUndefined();
    const [b] = await db()<{ owner_id: string | null }[]>`
      SELECT owner_id FROM bots WHERE handle = 'alice'`;
    expect(b?.owner_id).toBeNull();
  });

  it("links with that person's own owner code", async () => {
    const token = await autoConnect("google-1");
    const { code } = await issueOwnerCode(db(), "google-1", null);
    const r = await tool(token, "sign_up", {
      handle: "alice",
      owner_code: code,
    });
    expect(r.data.bot.claimed).toBe(true);
    const [b] = await db()<{ owner_id: string }[]>`
      SELECT owner_id FROM bots WHERE handle = 'alice'`;
    expect(Number(b?.owner_id)).toBe(await findHuman(db(), "google-1"));
  });

  it("refuses someone else's owner code like one that doesn't work", async () => {
    const token = await autoConnect("google-1");
    const { code } = await issueOwnerCode(db(), "google-2", null);
    const r = await tool(token, "sign_up", {
      handle: "alice",
      owner_code: code,
    });
    expect(r.data.error.code).toBe("invalid_owner_code");
    expect(await count("bots")).toBe(0);
  });

  it("links with any person's owner code when no one was signed in, as today", async () => {
    const token = await autoConnect(null, CLAUDE);
    const { code } = await issueOwnerCode(db(), "google-2", null);
    const r = await tool(token, "sign_up", {
      handle: "alice",
      owner_code: code,
    });
    expect(r.data.bot.claimed).toBe(true);
    const plain = await tool(await autoConnect(null), "sign_up", {
      handle: "bob",
    });
    expect(plain.data.bot.claimed).toBe(false);
  });

  it("still becomes its person's bot with their connect code", async () => {
    const owner = await screenConnect("google-1");
    expect(
      (await tool(owner, "sign_up", { handle: "alice" })).data.bot.claimed,
    ).toBe(true);
    await ageLink("alice");
    const code = (await issueConnectCode(db(), "google-1", "alice", null)).code;
    const token = await autoConnect("google-1");
    const r = await tool(token, "sign_up", {
      handle: "alice",
      connect_code: code,
    });
    expect(r.isError).toBe(false);
    expect(r.data.bot.handle).toBe("alice");
    // Another person's connection, approved without the page, can't use it.
    const code2 = (await issueConnectCode(db(), "google-1", "alice", null))
      .code;
    const stranger = await autoConnect("google-2");
    const s = await tool(stranger, "sign_up", {
      handle: "alice",
      connect_code: code2,
    });
    expect(s.data.error.code).toBe("invalid_connect_code");
  });

  it("leaves a connection approved on the page linking when there's room, as today", async () => {
    const token = await screenConnect("google-1");
    const r = await tool(token, "sign_up", { handle: "alice" });
    expect(r.data.bot.claimed).toBe(true);
    const [g] = await db()<{ auto_approved: boolean }[]>`
      SELECT auto_approved FROM connector_grants`;
    expect(g?.auto_approved).toBe(false);
  });

  // The attack this guards against: a stranger registers their own client
  // with ChatGPT's callback, makes a link with their own PKCE challenge and
  // state, and sends it to a signed-in person. With no page to stop them,
  // the person's browser approves it; the stranger's bot must not end up
  // linked to the person.
  it("never hands a stranger a bot linked to the person who opened their link", async () => {
    const attacker = await clientFor([CHATGPT], "ChatGPT");
    const { verifier, challenge } = pkce();
    session.user = { id: "google-victim" };
    const r = await page(params(attacker, CHATGPT, challenge));
    const code = r.redirect?.searchParams.get("code") ?? "";
    // Say the code reaches the stranger.
    const res = await exchange({
      grant_type: "authorization_code",
      code,
      client_id: attacker,
      code_verifier: verifier,
      redirect_uri: CHATGPT,
    });
    const token = res.body.access_token;
    const joined = await tool(token, "sign_up", { handle: "mallory" });
    expect(joined.data.bot.claimed).toBe(false);
    // A code the stranger planted, or made themselves, doesn't work either.
    const own = await issueOwnerCode(db(), "google-mallory", null);
    const token2 = await (async () => {
      const { verifier: v, challenge: c } = pkce();
      session.user = { id: "google-victim" };
      const again = await page(params(attacker, CHATGPT, c));
      return (
        await exchange({
          grant_type: "authorization_code",
          code: again.redirect?.searchParams.get("code") ?? "",
          client_id: attacker,
          code_verifier: v,
          redirect_uri: CHATGPT,
        })
      ).body.access_token;
    })();
    const planted = await tool(token2, "sign_up", {
      handle: "mallory2",
      owner_code: own.code,
    });
    expect(planted.data.error.code).toBe("invalid_owner_code");
    const victim = await findHuman(db(), "google-victim");
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bots WHERE owner_id = ${victim ?? 0}`;
    expect(n?.n).toBe(0);
  });
});

describe("the approval page", () => {
  it("never says the account is full, at the cap or below it", async () => {
    session.user = { id: "google-1" };
    for (let i = 0; i < MAX_BOTS_PER_HUMAN; i++) {
      const { code } = await issueOwnerCode(db(), "google-1", null);
      await register(`bot-${i}`, { owner_code: code });
    }
    const id = await clientFor([OTHER]);
    const r = await page(params(id, OTHER, pkce().challenge));
    expect(r.html).toContain("Allow");
    expect(r.html).not.toMatch(/the most you can link/);
  });
});
