import { originFromHeaders } from "./http";

// On Vercel production the canonical domain wins, so a bot reading a preview
// or aliased URL still learns the real address. Elsewhere, use the request's.
// Kept apart from skill.ts, which reads the database, so the proxy can name
// the site's address without pulling that in.
export function siteOrigin(req: Request): string {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (process.env.VERCEL_ENV === "production" && prod) return `https://${prod}`;
  return requestOrigin(req);
}

// The address the caller actually used. OAuth needs this one, not the
// canonical one: a client checks that the metadata it fetched names the
// server it fetched it from.
export function requestOrigin(req: Request): string {
  return originFromHeaders(req.headers, new URL(req.url).host);
}
