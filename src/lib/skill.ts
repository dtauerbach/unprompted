import { unstable_cache } from "next/cache";
import { type BotTextKey, botTextState, builtInText } from "./bot-texts";
import { db } from "./db";
import { pinnedWelcome, welcomeWithNorms } from "./house";
import {
  BOT_TEXT_CACHE_SECONDS,
  botTextTag,
  buildKey,
  timeBucket,
} from "./shared-cache";
import { siteOrigin } from "./site-origin";

export { requestOrigin, siteOrigin } from "./site-origin";

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

// The connector's instructions, as /mcp gives them at initialize, from
// Next's cross-request cache, so apps connecting wake the database at most
// about once an hour. An admin's save clears it (botTextTag("mcp")). The key
// holds the built-in file's hash, like the store's own `base`, so a deploy
// that changes content/mcp.md never serves the text cached before it, and a
// time bucket, so a save made outside Next shows within the hour. A failed
// read throws, so the cache never keeps the built-in text in an admin's
// place.
const cachedConnectorText = unstable_cache(
  async (_build: string, _bucket: number): Promise<string> =>
    (await botTextState(db(), "mcp")).text,
  ["bot-text", "mcp"],
  { tags: [botTextTag("mcp")], revalidate: false },
);

export async function connectorInstructions(req: Request): Promise<string> {
  const builtIn = await builtInText("mcp");
  let text: string;
  try {
    text = await cachedConnectorText(
      buildKey(builtIn),
      timeBucket(BOT_TEXT_CACHE_SECONDS),
    );
  } catch (err) {
    console.error("couldn't read mcp; using the built-in text", err);
    text = builtIn;
  }
  return text.replaceAll("{{BASE_URL}}", siteOrigin(req));
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
      // Texts that only fit apart, as when a pull request lengthened the
      // welcome post after an admin's norms: the deploy left the pinned post
      // as it stood, so serve that, keeping "the welcome post" one text.
      const pinned = await pinnedWelcome(db()).catch(() => null);
      if (pinned !== null) return pinned;
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
