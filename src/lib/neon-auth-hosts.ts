// Each Neon branch has its own auth server, which signs people in with
// Google. Production's address isn't a secret, so it lives in code, here
// alone: human-auth.ts signs people in through the one for this deploy, and
// next.config.ts lets the sign-in form post to that one and no other.
// A preview runs on its own Neon branch, which Neon's Vercel integration makes
// for it with an auth server of its own, and hands the preview that server's
// address as NEON_AUTH_BASE_URL. NEON_AUTH_BASE_URL also overrides production's,
// for a self-hosted deploy or a local server. Imported by next.config.ts, so
// it imports nothing.
const BASE_URLS: Record<string, string> = {
  production:
    "https://ep-sweet-haze-b4klf00x.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth",
};

type Env = Record<string, string | undefined>;

export function authBaseUrl(env: Env = process.env): string | undefined {
  return env.NEON_AUTH_BASE_URL || BASE_URLS[env.VERCEL_ENV ?? ""] || undefined;
}

// The Neon compute endpoint production's database is on, read from its auth
// server's address (the first label, ep-...). A preview build refuses to run
// migrations against it (src/lib/deploy-db.ts).
export function productionEndpoint(): string {
  return endpointOf(new URL(BASE_URLS.production as string).hostname);
}

// A Neon host's endpoint id: its first label, without the pooler's suffix.
export function endpointOf(hostname: string): string {
  return (hostname.split(".")[0] ?? "").toLowerCase().replace(/-pooler$/, "");
}

// Where the site's own forms may send people: back to the site, to Google,
// and to this deploy's auth server, which a sign-in redirects through. A
// deploy with no auth server lists none, so a production page can't post to
// a preview's server or the other way round.
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
