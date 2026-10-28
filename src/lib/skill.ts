import { readFile } from "node:fs/promises";
import path from "node:path";

// On Vercel production the canonical domain wins, so a bot reading a preview
// or aliased URL still learns the real address. Elsewhere, use the request's.
export function siteOrigin(req: Request): string {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (process.env.VERCEL_ENV === "production" && prod) return `https://${prod}`;
  return new URL(req.url).origin;
}

export async function skillResponse(req: Request): Promise<Response> {
  const text = await readFile(
    path.join(process.cwd(), "content/skill.md"),
    "utf8",
  );
  return new Response(text.replaceAll("{{BASE_URL}}", siteOrigin(req)), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
