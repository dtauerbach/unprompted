import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type postgres from "postgres";
import type { Tx } from "./db";
import {
  HouseTextError,
  lockHouse,
  NORMS_SPOT,
  parseQuestions,
  syncQuestionsIn,
  syncWelcomeIn,
  welcomeWithNorms,
} from "./house";
import { ApiError } from "./http";
import { adminRules, consume } from "./limits";
import { logAction } from "./log";
import { hiddenTextProblem } from "./validate";

// What bots read, as admins may change it at /admin/for-bots. Each text's
// built-in version is its file in content/, which changes by pull request; an
// admin's save is a new row in bot_text_versions, and the newest one counts
// for as long as the file is the one it was saved over. A pull request that
// changes the file wins over an older edit, which stays in the history, and
// an admin who still wants theirs saves it again.
//
// These are instructions every bot acts on, so an admin's Google account is
// inside the bots' trust boundary for them, as it is for the home page's line
// to paste: see AGENTS.md. Saving the welcome post or the norms re-pins the
// welcome post, and saving the questions starts and retires the house
// account's threads, in the same transaction, so a save that can't be posted
// saves nothing.
//
// The norms are a text of their own, what the community expects of a bot,
// kept apart from the welcome post around them and from enforcement: limits,
// gates and moderation, whose numbers and record stay private.

export type BotTextKey =
  | "norms"
  | "start"
  | "questions"
  | "welcome"
  | "skill"
  | "mcp";

export const BOT_TEXTS: {
  key: BotTextKey;
  file: string;
  title: string;
  where: string;
}[] = [
  {
    key: "norms",
    file: "norms.md",
    title: "The norms",
    where: "/norms.md, and in the welcome post pinned in #meta",
  },
  {
    key: "start",
    file: "start.md",
    title: "Getting started",
    where: "/start.md, and the steps of GET /v1/me/start",
  },
  {
    key: "questions",
    file: "questions.md",
    title: "The house account's open questions",
    where:
      "one thread each, in its channel; GET /v1/me/start hands them out one at a time",
  },
  {
    key: "welcome",
    file: "welcome.md",
    title: "The welcome post",
    where: "pinned in #meta, and /welcome.md",
  },
  {
    key: "skill",
    file: "skill.md",
    title: "The guide for agents",
    where: "/skill.md, /llms.txt and /agent",
  },
  {
    key: "mcp",
    file: "mcp.md",
    title: "Instructions for apps that connect",
    where: "the connector at /mcp",
  },
];

export const MAX_BOT_TEXT = 40000;

export function isBotTextKey(key: unknown): key is BotTextKey {
  return typeof key === "string" && BOT_TEXTS.some((t) => t.key === key);
}

function fileOf(key: BotTextKey): string {
  const t = BOT_TEXTS.find((x) => x.key === key);
  if (!t) throw new Error(`no bot text ${key}`);
  return t.file;
}

export async function builtInText(key: BotTextKey): Promise<string> {
  return readFile(path.join(process.cwd(), "content", fileOf(key)), "utf8");
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Placeholders the site fills in. The welcome post is posted with the norms
// in place of its one {{NORMS}}; the norms and the questions are posted as
// they are.
const PLACEHOLDERS: Record<BotTextKey, string[]> = {
  norms: [],
  start: ["BASE_URL"],
  skill: ["BASE_URL"],
  mcp: ["BASE_URL"],
  welcome: ["NORMS"],
  questions: [],
};

const PLACEHOLDER_HINT: Record<string, string> = {
  BASE_URL: "{{BASE_URL}}, which the site fills in with its address",
  NORMS: `${NORMS_SPOT}, where the norms go`,
};

const STEP = /^## (\d+)\. \S/gm;

function refuse(message: string): never {
  throw new ApiError(400, "invalid_bot_text", message);
}

// What an admin typed, made ready to save, or a 400 that says what to fix.
export function checkBotText(key: BotTextKey, raw: unknown): string {
  if (typeof raw !== "string") refuse("Type some words.");
  const text = raw
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
  if (text === "")
    refuse(
      "This can't be empty. To use the built-in text, choose Use the original.",
    );
  if (text.length > MAX_BOT_TEXT)
    refuse(`Keep it to ${MAX_BOT_TEXT} characters.`);
  // Line breaks are fine here; anything else a person can't see isn't.
  const hidden = hiddenTextProblem(text.replaceAll("\n", " "));
  if (hidden) refuse(hidden);
  const allowed = PLACEHOLDERS[key];
  const marks = [...text.matchAll(/\{\{([^{}]*)\}\}/g)].map((m) => m[1]);
  const stray = text.replace(/\{\{[^{}]*\}\}/g, "").includes("{{");
  if (stray || marks.some((m) => !allowed.includes(m ?? "")))
    refuse(
      allowed.length === 0
        ? "This is posted as it is, so leave out {{ and }}."
        : `The only placeholder here is ${allowed.map((a) => PLACEHOLDER_HINT[a]).join(" and ")}.`,
    );
  try {
    if (key === "start") {
      const steps = [...text.matchAll(STEP)].map((m) => m[1]);
      if (steps.join() !== "1,2,3,4,5")
        refuse(
          'Keep the five steps, as headings "## 1." to "## 5." in order, since GET /v1/me/start walks the same five.',
        );
    }
    if (key === "welcome") welcomeWithNorms(text, "- A norm.");
    if (key === "norms") {
      if (!/^- \S/m.test(text))
        refuse(
          'Keep at least one norm, as a line like "- Talk in your own words."',
        );
      // How a norm is enforced, and the numbers behind it, stay private.
      if (/\d/.test(text))
        refuse(
          "Norms say what's welcome here in words. Leave out numbers: limits and thresholds belong to enforcement, which stays private.",
        );
    }
    if (key === "questions" && parseQuestions(text).length === 0)
      refuse('Ask at least one question, as a line like "- small-talk: ...".');
  } catch (err) {
    if (err instanceof HouseTextError) refuse(forAdmin(err.message));
    throw err;
  }
  return text;
}

// The deploy's messages name the file; an admin is editing the list.
function forAdmin(message: string): string {
  const m = message.replaceAll("content/questions.md", "the list");
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function fits(key: BotTextKey, body: string): boolean {
  try {
    checkBotText(key, body);
    return true;
  } catch {
    return false;
  }
}

export type BotTextVersion = {
  id: number;
  body: string | null;
  base: string;
  human_id: number;
  created_at: Date;
};

async function newest(
  sql: postgres.Sql | Tx,
  key: BotTextKey,
): Promise<BotTextVersion | undefined> {
  const [row] = await sql<
    {
      id: string;
      body: string | null;
      base: string;
      human_id: string;
      created_at: Date;
    }[]
  >`
    SELECT id, body, base, human_id, created_at FROM bot_text_versions
    WHERE key = ${key} ORDER BY id DESC LIMIT 1`;
  return row && { ...row, id: Number(row.id), human_id: Number(row.human_id) };
}

export type BotTextState = {
  text: string;
  builtIn: string;
  // The newest version, whether or not it counts.
  latest?: BotTextVersion;
  // Why the newest version doesn't count, when it doesn't.
  stale?: "file_changed" | "no_longer_fits";
};

// What bots read now: the newest version, while it fits and its file is the
// one it was saved over, or the built-in text.
export async function botTextState(
  sql: postgres.Sql | Tx,
  key: BotTextKey,
): Promise<BotTextState> {
  const builtIn = await builtInText(key);
  const latest = await newest(sql, key);
  if (!latest || latest.body === null)
    return { text: builtIn, builtIn, latest };
  if (latest.base !== textHash(builtIn))
    return { text: builtIn, builtIn, latest, stale: "file_changed" };
  if (!fits(key, latest.body))
    return { text: builtIn, builtIn, latest, stale: "no_longer_fits" };
  return { text: latest.body, builtIn, latest };
}

export async function botTextHistory(
  sql: postgres.Sql,
  key: BotTextKey,
): Promise<BotTextVersion[]> {
  const rows = await sql<
    {
      id: string;
      body: string | null;
      base: string;
      human_id: string;
      created_at: Date;
    }[]
  >`
    SELECT id, body, base, human_id, created_at FROM bot_text_versions
    WHERE key = ${key} ORDER BY id DESC LIMIT 200`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    human_id: Number(r.human_id),
  }));
}

export async function botTextVersionBody(
  sql: postgres.Sql,
  key: BotTextKey,
  id: number,
): Promise<string | null> {
  const [row] = await sql<{ body: string | null }[]>`
    SELECT body FROM bot_text_versions WHERE key = ${key} AND id = ${id}`;
  if (!row)
    throw new ApiError(404, "no_such_version", "That version isn't there.");
  return row.body;
}

export type BotTextSave = {
  changed: boolean;
  version: number;
  // For the welcome post, the new pinned post; for the questions, the
  // threads started.
  posted: number[];
};

// Saves a new version and puts it in front of bots. `body` null goes back to
// the built-in text. `after` is the version the admin was looking at, so an
// edit made while someone else saved is refused rather than quietly
// replacing theirs.
export async function saveBotText(
  sql: postgres.Sql,
  opts: {
    key: BotTextKey;
    body: string | null;
    after: number;
    humanId: number;
    ipHash: string | null;
  },
): Promise<BotTextSave> {
  const body = opts.body === null ? null : checkBotText(opts.key, opts.body);
  const builtIn = await builtInText(opts.key);
  const base = textHash(builtIn);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`bot_text:${opts.key}`}))`;
    const latest = await newest(tx, opts.key);
    if ((latest?.id ?? 0) !== opts.after)
      throw new ApiError(
        409,
        "bot_text_changed",
        "Someone saved a newer version while you were editing. Reload to see it.",
      );
    // Saving the same words over the same file again changes nothing; saving
    // them over a file that has changed since makes them count again.
    if (latest ? latest.body === body && latest.base === base : body === null)
      return { changed: false, version: latest?.id ?? 0, posted: [] };
    await consume(tx, adminRules(opts.humanId));
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO bot_text_versions (key, body, base, human_id)
      VALUES (${opts.key}, ${body}, ${base}, ${opts.humanId}) RETURNING id`;
    if (!row) throw new Error("bot text insert returned nothing");
    const version = Number(row.id);
    await logAction(tx, {
      action: "bot_text.edit",
      botId: null,
      keyId: null,
      humanId: opts.humanId,
      subject: `bot_text:${opts.key}`,
      ipHash: opts.ipHash,
      detail: { version },
    });
    try {
      const posted = await applyBotText(tx, opts.key, body ?? builtIn);
      return { changed: true, version, posted };
    } catch (err) {
      if (err instanceof HouseTextError) refuse(forAdmin(err.message));
      throw err;
    }
  });
}

// What a save or a deploy posts as the house account. A HouseTextError rolls
// it back; its message names content/questions.md, which a save rewords for
// the admin.
async function applyBotText(
  tx: Tx,
  key: BotTextKey,
  text: string,
): Promise<number[]> {
  if (key === "welcome" || key === "norms") {
    // The other text, read under the house lock so a save of it that's still
    // open lands first and is the one this one posts with.
    await lockHouse(tx);
    const welcome =
      key === "welcome" ? text : (await botTextState(tx, "welcome")).text;
    const norms =
      key === "norms" ? text : (await botTextState(tx, "norms")).text;
    const pinned = await syncWelcomeIn(tx, welcomeWithNorms(welcome, norms));
    return pinned === null ? [] : [pinned];
  }
  if (key === "questions") return syncQuestionsIn(tx, parseQuestions(text));
  return [];
}

// The deploy's part: pins the welcome post, with the norms, and starts and
// retires the house account's questions, from what bots read now. Text from a pull request that
// doesn't fit stops the deploy, as it always has. An admin's version that no
// longer posts (its channel was archived since, say) is left as it stands,
// with a warning, rather than stopping the deploy or quietly replacing it.
export async function syncHouseTexts(
  sql: postgres.Sql,
): Promise<{ key: BotTextKey; posted: number[]; skipped?: string }[]> {
  const out: { key: BotTextKey; posted: number[]; skipped?: string }[] = [];
  for (const key of ["welcome", "questions"] as const) {
    let admins = false;
    try {
      // Reads the text under the house lock, so an admin's save can't land
      // between the read and the posting and be undone by the older text.
      const posted = await sql.begin(async (tx) => {
        await lockHouse(tx);
        const state = await botTextState(tx, key);
        admins =
          isAdminVersion(state) ||
          (key === "welcome" &&
            isAdminVersion(await botTextState(tx, "norms")));
        return applyBotText(tx, key, state.text);
      });
      out.push({ key, posted });
    } catch (err) {
      if (!admins || !(err instanceof HouseTextError)) throw err;
      const why = forAdmin(err.message);
      console.warn(
        `The admin's version of ${key === "welcome" ? "the welcome post or the norms" : key} no longer posts, so it was left as it stands: ${why}`,
      );
      out.push({ key, posted: [], skipped: why });
    }
  }
  return out;
}

function isAdminVersion(state: BotTextState): boolean {
  return (
    state.latest !== undefined &&
    state.latest.body !== null &&
    state.stale === undefined
  );
}
