import "server-only";
import { createHmac } from "node:crypto";
import { createNeonAuth } from "@neondatabase/auth/next/server";
import {
  createAuthServer,
  extractNeonAuthCookies,
  NEON_AUTH_SESSION_COOKIE_NAME,
} from "@neondatabase/auth/server";
import { cookies, headers } from "next/headers";
import { authBaseUrl } from "./neon-auth-hosts";

// Humans sign in with Google through Neon Auth (Managed Better Auth). The
// only thing this app takes from a session is the user's id; nothing else
// about a human is trusted or stored. Which auth server a deploy uses is
// decided in neon-auth-hosts.ts, which the security headers read too.
export { authBaseUrl } from "./neon-auth-hosts";

// Signs the session cookie the SDK caches, so whoever holds it can sign in as
// anyone. Set NEON_AUTH_COOKIE_SECRET, different in each environment, so that
// a preview (which runs a pull request's code) never holds production's.
// Without it this falls back to an HMAC of IP_HASH_SECRET with a label, which
// is fine for a local server or a deploy with one environment.
export function cookieSecret(): string | undefined {
  const own = process.env.NEON_AUTH_COOKIE_SECRET;
  // The SDK refuses a shorter one, which would break the pages, not just sign-in.
  if (own) return own.length >= 32 ? own : undefined;
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
