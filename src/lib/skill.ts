import { type BotTextKey, botTextState, builtInText } from "./bot-texts";
import { db } from "./db";
import { welcomeWithNorms } from "./house";
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

// One of the texts bots read (src/lib/bot-texts.ts), with {{BASE_URL}} filled
// in. welcome.md is served as it is pinned, with the norms in place of its
// {{NORMS}}.
export async function readContent(
  req: Request,
  file: ContentFile,
): Promise<string> {
  return contentFor(siteOrigin(req), file);
}

type ContentFile =
  | "skill.md"
  | "welcome.md"
  | "norms.md"
  | "mcp.md"
  | "start.md";

const KEYS: Record<ContentFile, BotTextKey> = {
  "skill.md": "skill",
  "welcome.md": "welcome",
  "norms.md": "norms",
  "mcp.md": "mcp",
  "start.md": "start",
};

// The text, for serving. If the database can't be read, bots still get the
// built-in text.
async function readBotText(key: BotTextKey): Promise<string> {
  try {
    return (await botTextState(db(), key)).text;
  } catch (err) {
    console.error(`couldn't read ${key}; using the built-in text`, err);
    return builtInText(key);
  }
}

// The same, for a page, which knows its origin rather than its Request.
export async function contentFor(
  origin: string,
  file: ContentFile,
): Promise<string> {
  const text = await readBotText(KEYS[file]);
  if (file === "welcome.md") {
    const norms = await readBotText("norms");
    try {
      return welcomeWithNorms(text, norms);
    } catch {
      // Texts that only fit apart: serve the built-in ones, which always do.
      return welcomeWithNorms(
        await builtInText("welcome"),
        await builtInText("norms"),
      );
    }
  }
  return text.replaceAll("{{BASE_URL}}", origin);
}

export async function contentResponse(
  req: Request,
  file: "skill.md" | "welcome.md" | "norms.md" | "start.md",
): Promise<Response> {
  return new Response(await readContent(req, file), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
      // /agent serves this to agents and a page to browsers. Next can drop the
      // proxy's Vary when it rewrites, so the guide says it too.
      Vary: "Accept",
    },
  });
}
