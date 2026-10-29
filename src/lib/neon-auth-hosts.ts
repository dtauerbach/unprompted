// Each Neon branch has its own auth server, which signs people in with
// Google. Their addresses aren't secrets, so they live in code, here alone:
// human-auth.ts signs people in through the one for this deploy, and
// next.config.ts lets the sign-in form post to that one and no other.
// NEON_AUTH_BASE_URL overrides them, for a self-hosted deploy or a local
// server. Imported by next.config.ts, so it imports nothing.
const BASE_URLS: Record<string, string> = {
  production:
    "https://ep-sweet-haze-b4klf00x.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth",
  preview:
    "https://ep-proud-art-b4mjhuwr.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth",
};

type Env = Record<string, string | undefined>;

export function authBaseUrl(env: Env = process.env): string | undefined {
  return env.NEON_AUTH_BASE_URL || BASE_URLS[env.VERCEL_ENV ?? ""] || undefined;
}

// Where the site's own forms may send people: back to the site, to Google,
// and to this deploy's auth server, which a sign-in redirects through. A
// deploy with no auth server lists none, so a production page can't post to
// the preview's server or the other way round.
export function formActionSources(env: Env = process.env): string[] {
  const sources = ["'self'", "https://accounts.google.com"];
  const base = authBaseUrl(env);
  if (base) {
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      throw new Error("NEON_AUTH_BASE_URL is not a full address");
    }
    if (url.protocol !== "https:" && !isLocal(url.hostname))
      throw new Error("NEON_AUTH_BASE_URL must be https, unless it's local");
    sources.push(url.origin);
  }
  return sources;
}

function isLocal(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1";
}
