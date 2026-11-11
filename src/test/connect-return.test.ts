import { createHash, randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerClientRoute } from "@/app/v1/oauth/register/route";
import {
  approvalPath,
  CONNECT_COOKIE,
  CONNECT_RETURN_MINUTES,
  isNonce,
  openReturn,
  returnPath,
  sealReturn,
} from "@/lib/connect-return";
import { db } from "@/lib/db";
import { safeNext, signInPath } from "@/lib/sign-in-next";
import { call, resetDb } from "./helpers";

// Signing in from the approval page comes back to the same request: the
// request rides in a signed, short-lived cookie under a nonce, Google sends
// the person to a path carrying the nonce, and that path puts the request
// back on the approval page, which checks it again. Nothing else can bring
// anyone back to a request.

const auth = vi.hoisted(() => ({
  secret: "s".repeat(64) as string | undefined,
  calls: [] as { callbackURL?: string }[],
}));
const origin = vi.hoisted(() => ({ site: "https://unprompted.test" }));
const nav = vi.hoisted(() => ({ redirects: [] as string[] }));
const jar = vi.hoisted(() => ({
  set: [] as { name: string; value: string; opts: Record<string, unknown> }[],
}));

vi.mock("@/lib/human-auth", () => ({
  cookieSecret: () => auth.secret,
  humanSignInEnabled: () => auth.secret !== undefined,
  sessionUser: async () => null,
  neonAuth: () =>
    auth.secret
      ? {
          signIn: {
            social: async (o: { callbackURL?: string }) => {
              auth.calls.push(o);
              return {
                data: { url: "https://accounts.google.com/x" },
                error: null,
              };
            },
          },
        }
      : undefined,
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-real-ip": "10.7.7.7", host: "unprompted.test" }),
  cookies: async () => ({
    set: (name: string, value: string, opts: Record<string, unknown>) =>
      jar.set.push({ name, value, opts }),
  }),
}));
vi.mock("@/lib/page-origin", () => ({
  pageOrigin: async () => origin.site,
  pageRequestOrigin: async () => "https://unprompted.test",
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
  auth.secret = "s".repeat(64);
  auth.calls = [];
  origin.site = "https://unprompted.test";
  nav.redirects = [];
  jar.set = [];
});

const REDIRECT = "https://agent.example/callback";

async function request(extra: Record<string, string> = {}) {
  const res = await call(registerClientRoute, {
    body: { redirect_uris: [REDIRECT], client_name: "Agent App" },
  });
  expect(res.status).toBe(201);
  const challenge = createHash("sha256")
    .update(randomBytes(32).toString("base64url"))
    .digest("base64url");
  return {
    response_type: "code",
    client_id: res.body.client_id as string,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    ...extra,
  };
}

function formOf(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function back(nonce: string, cookie?: string) {
  const { GET } = await import("@/app/oauth/authorize/return/[nonce]/route");
  const req = new Request(
    `https://unprompted.test/oauth/authorize/return/${nonce}`,
    {
      headers: cookie ? { cookie: `other=1; ${CONNECT_COOKIE}=${cookie}` } : {},
    },
  );
  const res = await GET(req, { params: Promise.resolve({ nonce }) });
  return {
    status: res.status,
    location: res.headers.get("location") ?? "",
    setCookie: res.headers.get("set-cookie") ?? "",
    cache: res.headers.get("cache-control"),
  };
}

describe("the sealed request", () => {
  const params = {
    response_type: "code",
    client_id: "unc_aaaaaaaaaaaaaaaaaaaaaa",
    state: "a&b=c d",
  };

  it("opens only for its own nonce, untouched, before it expires", () => {
    const now = Date.now();
    const s = sealReturn(params, now);
    if (!s) throw new Error("no seal");
    expect(isNonce(s.nonce)).toBe(true);
    expect(openReturn(s.value, s.nonce, now)).toEqual(params);
    expect(
      openReturn(s.value, s.nonce, now + CONNECT_RETURN_MINUTES * 60_000 - 1),
    ).toEqual(params);
    expect(
      openReturn(s.value, s.nonce, now + CONNECT_RETURN_MINUTES * 60_000 + 1),
    ).toBeUndefined();
    const other = sealReturn(params, now);
    expect(other?.nonce).not.toBe(s.nonce);
    expect(openReturn(s.value, other?.nonce ?? "", now)).toBeUndefined();
    expect(openReturn(undefined, s.nonce, now)).toBeUndefined();
    expect(openReturn(s.value, "short", now)).toBeUndefined();
  });

  it("refuses anything this site didn't sign", () => {
    const s = sealReturn(params);
    if (!s) throw new Error("no seal");
    const [payload, sig] = s.value.split(".") as [string, string];
    // A payload swapped for one naming another app, keeping the signature.
    const forged = Buffer.from(
      JSON.stringify({
        n: s.nonce,
        e: Date.now() + 60_000,
        q: { ...params, client_id: "unc_bbbbbbbbbbbbbbbbbbbbbb" },
      }),
    ).toString("base64url");
    expect(openReturn(`${forged}.${sig}`, s.nonce)).toBeUndefined();
    expect(openReturn(`${payload}.${sig.slice(1)}x`, s.nonce)).toBeUndefined();
    expect(openReturn(`${payload}.${sig}.x`, s.nonce)).toBeUndefined();
    expect(openReturn(payload, s.nonce)).toBeUndefined();
    // Signed with another secret: another deploy's cookie is worthless here.
    auth.secret = "t".repeat(64);
    expect(openReturn(s.value, s.nonce)).toBeUndefined();
  });

  it("keeps only the request's own fields", () => {
    const s = sealReturn({ ...params, owner_id: "1", human: "google-1" });
    if (!s) throw new Error("no seal");
    expect(openReturn(s.value, s.nonce)).toEqual(params);
  });

  it("isn't made when sign-in isn't set up, or the request is too big to carry", () => {
    expect(sealReturn({ ...params, state: "x".repeat(5000) })).toBeUndefined();
    auth.secret = undefined;
    expect(sealReturn(params)).toBeUndefined();
  });

  it("goes back to the approval page and nowhere else", () => {
    expect(approvalPath(params)).toBe(
      "/oauth/authorize?response_type=code&client_id=unc_aaaaaaaaaaaaaaaaaaaaaa&state=a%26b%3Dc+d",
    );
    expect(approvalPath({})).toBe("/oauth/authorize");
  });
});

describe("where signing in may send a person back", () => {
  it("allows the way back to a request, and only its exact shape", () => {
    const path = returnPath("A".repeat(22));
    expect(safeNext(path)).toBe(path);
    expect(signInPath(path)).toBe(`/sign-in?next=${encodeURIComponent(path)}`);
    for (const bad of [
      `/oauth/authorize/return/${"A".repeat(21)}`,
      `/oauth/authorize/return/${"A".repeat(23)}`,
      `/oauth/authorize/return/${"A".repeat(22)}/x`,
      `/oauth/authorize/return/${"A".repeat(22)}?x=1`,
      `/oauth/authorize/return/${"A".repeat(21)}.`,
      "/oauth/authorize/return/",
      "/oauth/authorize",
      "/oauth/authorize?client_id=unc_x",
      `//evil.example/oauth/authorize/return/${"A".repeat(22)}`,
      `/oauth/authorize/return/../../${"A".repeat(16)}`,
    ])
      expect(safeNext(bad), bad).toBeUndefined();
  });
});

describe("signing in from the approval page", () => {
  it("keeps the checked request in a cookie and sends Google back to its nonce", async () => {
    const a = await import("@/app/oauth/authorize/actions");
    const fields = await request();
    // Fields the request doesn't have ride nowhere.
    await expect(
      a.signInToConnect(formOf({ ...fields, owner_id: "7" })),
    ).rejects.toThrow("redirect https://accounts.google.com/x");
    expect(jar.set).toHaveLength(1);
    const [c] = jar.set;
    expect(c?.name).toBe(CONNECT_COOKIE);
    expect(c?.opts).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/oauth/authorize/return",
      maxAge: CONNECT_RETURN_MINUTES * 60,
    });
    const callback = new URL(auth.calls[0]?.callbackURL ?? "");
    expect(callback.origin).toBe("https://unprompted.test");
    const nonce = callback.pathname.split("/").pop() ?? "";
    expect(callback.pathname).toBe(returnPath(nonce));
    expect(openReturn(c?.value, nonce)).toEqual(fields);
    // Nothing is written to the database: no grant, no human.
    const [g] = await db()<{ n: number }[]>`
      SELECT (SELECT count(*) FROM connector_grants)::int + (SELECT count(*) FROM humans)::int AS n`;
    expect(g?.n).toBe(0);
  });

  it("falls back to the plain sign-in page for a request that doesn't check out", async () => {
    const a = await import("@/app/oauth/authorize/actions");
    const good = await request();
    for (const bad of [
      { ...good, client_id: "unc_nobodynobodynobody00" },
      { ...good, redirect_uri: "https://evil.example/callback" },
      { ...good, code_challenge_method: "plain" },
      {},
    ]) {
      await expect(a.signInToConnect(formOf(bad))).rejects.toThrow(
        "redirect /sign-in",
      );
    }
    expect(jar.set).toHaveLength(0);
    expect(auth.calls).toHaveLength(0);
  });

  it("falls back to the plain sign-in page with no sign-in set up", async () => {
    const a = await import("@/app/oauth/authorize/actions");
    const fields = await request();
    auth.secret = undefined;
    await expect(a.signInToConnect(formOf(fields))).rejects.toThrow(
      "redirect /sign-in",
    );
    expect(jar.set).toHaveLength(0);
  });

  it("falls back to the plain sign-in page for a request too big to carry", async () => {
    const a = await import("@/app/oauth/authorize/actions");
    // Each field passes its 500-character check, but three bytes a character
    // is more than a cookie holds.
    const fields = await request({
      state: "€".repeat(500),
      scope: "€".repeat(500),
      resource: "€".repeat(500),
    });
    const { checkAuthorize } = await import("@/lib/connector");
    expect((await checkAuthorize(fields, "https://unprompted.test")).kind).toBe(
      "ok",
    );
    await expect(a.signInToConnect(formOf(fields))).rejects.toThrow(
      "redirect /sign-in",
    );
    expect(jar.set).toHaveLength(0);
    expect(auth.calls).toHaveLength(0);
  });

  it("falls back to the plain sign-in page on a host name that isn't the site's own", async () => {
    const a = await import("@/app/oauth/authorize/actions");
    const fields = await request();
    origin.site = "https://unprompted.example";
    await expect(a.signInToConnect(formOf(fields))).rejects.toThrow(
      "redirect /sign-in",
    );
    expect(jar.set).toHaveLength(0);
    expect(auth.calls).toHaveLength(0);
  });

  it("marks the cookie Secure in production, setting it and clearing it", async () => {
    const fields = await request();
    vi.stubEnv("NODE_ENV", "production");
    try {
      const a = await import("@/app/oauth/authorize/actions");
      await expect(a.signInToConnect(formOf(fields))).rejects.toThrow(
        "redirect https://accounts.google.com/x",
      );
      expect(jar.set[0]?.opts.secure).toBe(true);
      const s = sealReturn(fields);
      if (!s) throw new Error("no seal");
      const r = await back(s.nonce, s.value);
      expect(r.setCookie).toMatch(/; HttpOnly; SameSite=Lax; Secure$/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("coming back from Google", () => {
  it("puts the request back on the approval page, once, and clears the cookie", async () => {
    const fields = await request();
    const s = sealReturn(fields);
    if (!s) throw new Error("no seal");
    const r = await back(s.nonce, s.value);
    expect(r.status).toBe(303);
    expect(r.location).toBe(approvalPath(fields));
    expect(r.cache).toBe("no-store");
    expect(r.setCookie).toMatch(
      new RegExp(
        `^${CONNECT_COOKIE}=; Path=/oauth/authorize/return; Max-Age=0; HttpOnly; SameSite=Lax$`,
      ),
    );
    // The page itself checks the request again, from the address alone.
    const { checkAuthorize } = await import("@/lib/connector");
    const restored = Object.fromEntries(
      new URL(r.location, "https://unprompted.test").searchParams,
    );
    expect(
      (await checkAuthorize(restored, "https://unprompted.test")).kind,
    ).toBe("ok");
  });

  it("brings nobody back to a request without this browser's cookie for it", async () => {
    const fields = await request();
    const s = sealReturn(fields);
    const other = sealReturn(fields);
    if (!s || !other) throw new Error("no seal");
    for (const [nonce, cookie] of [
      [s.nonce, undefined],
      [s.nonce, other.value],
      [other.nonce, s.value],
      [s.nonce, `${s.value}x`],
      ["not-a-nonce", s.value],
    ] as [string, string | undefined][]) {
      const r = await back(nonce, cookie);
      expect(r.status).toBe(303);
      expect(r.location, nonce).toBe("/oauth/authorize");
      expect(r.setCookie).toContain("Max-Age=0");
    }
  });
});

describe("the approval page", () => {
  async function page(fields: Record<string, string>) {
    const Page = (await import("@/app/oauth/authorize/page")).default;
    return renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve(fields) }),
    );
  }

  it("signs a signed-out person in through a form that carries the request", async () => {
    const fields = await request();
    const html = await page({ ...fields, owner_id: "7" });
    expect(html).toMatch(/<button type="submit" form="connect-sign-in"/);
    expect(html).toMatch(/<form id="connect-sign-in"[^>]*hidden/);
    for (const [k, v] of Object.entries(fields))
      expect(html).toContain(`name="${k}" value="${v}"`);
    expect(html).not.toContain('name="owner_id"');
    // No plain link to sign in that would lose the request.
    expect(html).not.toContain('href="/sign-in"');
  });

  it("offers no sign-in when sign-in isn't set up", async () => {
    const fields = await request();
    auth.secret = undefined;
    const html = await page(fields);
    expect(html).not.toContain("connect-sign-in");
  });
});

describe("the proxy", () => {
  it("finishes sign-in on the way back, so the return sees the session", async () => {
    const { config } = await import("@/proxy");
    expect(config.matcher).toContain("/oauth/authorize/return/:nonce");
  });
});
