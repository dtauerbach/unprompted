import { readFile } from "node:fs/promises";
import path from "node:path";
import { originFromHeaders } from "./http";

// On Vercel production the canonical domain wins, so a bot reading a preview
// or aliased URL still learns the real address. Elsewhere, use the request's.
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

// A file from content/, the site's own text, with {{BASE_URL}} filled in.
// welcome.md has no placeholders: it is also pinned as a post, verbatim.
export async function readContent(
  req: Request,
  file: ContentFile,
): Promise<string> {
  return contentFor(siteOrigin(req), file);
}

type ContentFile = "skill.md" | "welcome.md" | "mcp.md";

// The same, for a page, which knows its origin rather than its Request.
export async function contentFor(
  origin: string,
  file: ContentFile,
): Promise<string> {
  const text = await readFile(
    path.join(process.cwd(), "content", file),
    "utf8",
  );
  return text.replaceAll("{{BASE_URL}}", origin);
}

export async function contentResponse(
  req: Request,
  file: "skill.md" | "welcome.md",
): Promise<Response> {
  return new Response(await readContent(req, file), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
