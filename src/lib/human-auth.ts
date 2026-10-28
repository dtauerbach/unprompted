import "server-only";
import { createHmac } from "node:crypto";
import { createNeonAuth } from "@neondatabase/auth/next/server";
import {
  createAuthServer,
  extractNeonAuthCookies,
  NEON_AUTH_SESSION_COOKIE_NAME,
} from "@neondatabase/auth/server";
import { cookies, headers } from "next/headers";

// Humans sign in with Google through Neon Auth (Managed Better Auth). The
// only thing this app takes from a session is the user's id; nothing else
// about a human is trusted or stored.
//
// Each Neon branch has its own auth server. Their addresses aren't secrets,
// so they live here rather than in Vercel's settings. NEON_AUTH_BASE_URL
// overrides them, for a self-hosted deploy or a local server.
const BASE_URLS: Record<string, string> = {
  production:
    "https://ep-sweet-haze-b4klf00x.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth",
  preview:
    "https://ep-proud-art-b4mjhuwr.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth",
};

export function authBaseUrl(): string | undefined {
  return (
    process.env.NEON_AUTH_BASE_URL ||
    BASE_URLS[process.env.VERCEL_ENV ?? ""] ||
    undefined
  );
}

// Signs the session cookie the SDK caches. Derived from IP_HASH_SECRET, which
// every deploy already has, so there's no second secret to set. A label keeps
// the two uses apart: knowing one derived value tells nothing about the other.
export function cookieSecret(): string | undefined {
  if (process.env.NEON_AUTH_COOKIE_SECRET)
    return process.env.NEON_AUTH_COOKIE_SECRET;
  const root = process.env.IP_HASH_SECRET;
  if (!root) return undefined;
  return createHmac("sha256", root)
    .update("unprompted:neon-auth-cookie")
    .digest("hex");
}

export function humanSignInEnabled(): boolean {
  return authBaseUrl() !== undefined && cookieSecret() !== undefined;
}

function config() {
  const baseUrl = authBaseUrl();
  const secret = cookieSecret();
  if (!baseUrl || !secret) return undefined;
  return { baseUrl, cookies: { secret }, logLevel: "warn" as const };
}

let full: ReturnType<typeof createNeonAuth> | undefined;

// For server actions and the proxy, which may set cookies.
export function neonAuth(): ReturnType<typeof createNeonAuth> | undefined {
  const c = config();
  if (!c) return undefined;
  full ??= createNeonAuth(c);
  return full;
}

let reader: ReturnType<typeof createAuthServer> | undefined;

// A page can't set cookies while it renders, so this one doesn't try. If the
// auth server refreshes a cookie, the proxy (src/proxy.ts) or the next
// action sets it instead.
function renderAuth(): ReturnType<typeof createAuthServer> | undefined {
  const c = config();
  if (!c) return undefined;
  reader ??= createAuthServer({
    baseUrl: c.baseUrl,
    cookieSecret: c.cookies.secret,
    context: async () => {
      const h = await headers();
      return {
        getCookies: () => extractNeonAuthCookies(h),
        setCookie: () => {},
        getHeader: (name: string) => h.get(name) ?? null,
        getOrigin: () => h.get("origin") ?? "",
        getFramework: () => "nextjs",
      };
    },
  });
  return reader;
}

export type SessionUser = { id: string; email: string | null };

// The signed-in human, or null. `forAction` uses the client that can set
// cookies; pages use the one that can't.
export async function sessionUser(
  opts: { forAction?: boolean } = {},
): Promise<SessionUser | null> {
  const auth = opts.forAction ? neonAuth() : renderAuth();
  if (!auth) return null;
  if (!opts.forAction) {
    // No session cookie means nobody is signed in; skip the network call.
    const jar = await cookies();
    if (!jar.has(NEON_AUTH_SESSION_COOKIE_NAME)) return null;
  }
  const { data } = await auth.getSession();
  const user = (data as { user?: { id?: unknown; email?: unknown } } | null)
    ?.user;
  if (typeof user?.id !== "string" || user.id === "") return null;
  return {
    id: user.id,
    email: typeof user.email === "string" ? user.email : null,
  };
}
