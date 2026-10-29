import { createHmac } from "node:crypto";
import {
  NEON_AUTH_SESSION_COOKIE_NAME,
  NEON_AUTH_SESSION_DATA_COOKIE_NAME,
} from "@neondatabase/auth/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real sessionUser, with only the request's cookies and the network
// faked. The SDK trusts its cached session cookie on its signature alone, so
// these check that a cookie signed with anything but our secret is no session.

const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: jar.cookie }),
  cookies: async () => ({
    has: (name: string) =>
      jar.cookie.split("; ").some((c) => c.startsWith(`${name}=`)),
  }),
}));

const SECRET = "s".repeat(40);
const saved = { ...process.env };
let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.NEON_AUTH_BASE_URL = "https://auth.invalid/neondb/auth";
  process.env.NEON_AUTH_COOKIE_SECRET = SECRET;
  // The auth server knows of no session for any token.
  upstream = vi.fn(async () => Response.json(null, { status: 401 }));
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["NEON_AUTH_BASE_URL", "NEON_AUTH_COOKIE_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function b64(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

function sessionData(userId: string) {
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const now = new Date().toISOString();
  return {
    session: {
      id: "s1",
      userId,
      expiresAt: later,
      createdAt: now,
      updatedAt: now,
    },
    user: {
      id: userId,
      email: `${userId}@example.com`,
      createdAt: now,
      updatedAt: now,
    },
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
  };
}

function jwt(payload: unknown, key: string | null): string {
  const alg = key === null ? "none" : "HS256";
  const head = `${b64({ alg, typ: "JWT" })}.${b64(payload)}`;
  if (key === null) return `${head}.`;
  return `${head}.${createHmac("sha256", key).update(head).digest("base64url")}`;
}

function signIn(data: string) {
  jar.cookie = `${NEON_AUTH_SESSION_COOKIE_NAME}=token-1; ${NEON_AUTH_SESSION_DATA_COOKIE_NAME}=${data}`;
}

async function user() {
  const { sessionUser } = await import("@/lib/human-auth");
  return sessionUser();
}

describe("a human's session", () => {
  it("is read from a cookie signed with the site's secret", async () => {
    signIn(jwt(sessionData("google-1"), SECRET));
    expect(await user()).toEqual({
      id: "google-1",
      email: "google-1@example.com",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("isn't taken from a cookie signed with another key", async () => {
    signIn(jwt(sessionData("google-1"), "w".repeat(40)));
    expect(await user()).toBeNull();
    // It asked the auth server instead, which knew of no session.
    expect(upstream).toHaveBeenCalled();
  });

  it("isn't taken from an unsigned cookie", async () => {
    signIn(jwt(sessionData("google-1"), null));
    expect(await user()).toBeNull();
  });

  it("isn't taken from a cookie whose body was swapped", async () => {
    const real = jwt(sessionData("google-1"), SECRET).split(".");
    signIn(`${real[0]}.${b64(sessionData("google-2"))}.${real[2]}`);
    expect(await user()).toBeNull();
  });

  it("isn't looked up at all without a session cookie", async () => {
    jar.cookie = `${NEON_AUTH_SESSION_DATA_COOKIE_NAME}=${jwt(sessionData("google-1"), SECRET)}`;
    expect(await user()).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("is no one when the auth server answers with no user id", async () => {
    upstream.mockImplementation(async () =>
      Response.json({ session: { id: "s" }, user: { id: "" } }),
    );
    signIn("not-a-jwt");
    expect(await user()).toBeNull();
  });
});
