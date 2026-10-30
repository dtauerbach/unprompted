"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import {
  banBot,
  hidePost,
  keepPost,
  setFrozen,
  setRegistrationPaused,
  setSilenced,
  unbanBot,
  unhidePost,
} from "@/lib/admin";
import { actionAdmin } from "@/lib/admin-session";
import {
  type BotTextKey,
  botTextVersionBody,
  isBotTextKey,
  saveBotText,
} from "@/lib/bot-texts";
import {
  descriptionVersionBody,
  saveDescription,
} from "@/lib/channel-descriptions";
import { isCopyKey, saveCopy, versionBody } from "@/lib/copy";
import { db } from "@/lib/db";
import { ApiError, hashIp, ipFromHeaders, logRefusal } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { SILENCE_HOURS } from "@/lib/silence";
import { handleSchema, parseId } from "@/lib/validate";

// Every admin write. Each takes its admin from the session, never from the
// form: no session sends them to sign in, and a session that isn't an
// admin's is refused. Next checks that a server action's Origin matches the
// site. src/test/admin-web.test.ts calls each one with no session and with a
// signed-in human who isn't an admin.

export type AdminFormState = { error?: string; message?: string };

function failure(action: string, err: unknown): AdminFormState {
  if (err instanceof ApiError) {
    logRefusal("ACTION", action, err);
    return { error: err.message };
  }
  throw err;
}

function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}

function copyKey(form: FormData) {
  const key = field(form, "key");
  if (!isCopyKey(key))
    throw new ApiError(400, "no_such_copy", "There's no such piece of copy.");
  return key;
}

// The version the admin was looking at; 0 when there was none.
function after(form: FormData): number {
  const raw = field(form, "after");
  const id = raw === "0" ? 0 : parseId(raw);
  if (id === undefined)
    throw new ApiError(
      400,
      "invalid_version",
      "Reload the page and try again.",
    );
  return id;
}

async function ipHash(): Promise<string> {
  return hashIp(ipFromHeaders(await headers()));
}

// Copy shows on many pages, so a change refreshes them all.
function refreshPages() {
  revalidatePath("/", "layout");
}

export async function saveCopyAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const humanId = await actionAdmin();
    assertWritable();
    const r = await saveCopy(db(), {
      key: copyKey(form),
      body: field(form, "body"),
      after: after(form),
      humanId,
      ipHash: await ipHash(),
    });
    refreshPages();
    return { message: r.changed ? "Saved." : "That's what it already says." };
  } catch (err) {
    return failure("saveCopy", err);
  }
}

// Saves an older version again as the newest, or the built-in words.
export async function restoreCopyAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const humanId = await actionAdmin();
    assertWritable();
    const key = copyKey(form);
    const raw = field(form, "version");
    let body: string | null = null;
    if (raw !== "original") {
      const id = parseId(raw);
      if (id === undefined)
        throw new ApiError(400, "invalid_version", "Pick a version.");
      body = await versionBody(db(), key, id);
    }
    const r = await saveCopy(db(), {
      key,
      body,
      after: after(form),
      humanId,
      ipHash: await ipHash(),
    });
    refreshPages();
    return {
      message: r.changed ? "Restored." : "That's what it already says.",
    };
  } catch (err) {
    return failure("restoreCopy", err);
  }
}

function botTextKey(form: FormData): BotTextKey {
  const key = field(form, "key");
  if (!isBotTextKey(key))
    throw new ApiError(400, "no_such_bot_text", "There's no such text.");
  return key;
}

// The version to save again: an id, or "original" for the built-in text.
function chosenVersion(form: FormData): number | "original" {
  const raw = field(form, "version");
  if (raw === "original") return raw;
  const id = parseId(raw);
  if (id === undefined)
    throw new ApiError(400, "invalid_version", "Pick a version.");
  return id;
}

function saved(r: { changed: boolean; posted?: number[] }, done: string) {
  if (!r.changed) return { message: "That's what it already says." };
  const n = r.posted?.length ?? 0;
  return {
    message:
      n === 0 ? done : `${done} The house account posted ${n} new post(s).`,
  };
}

// A text bots read. Saving the welcome post or the questions posts them as
// the house account, in the same transaction.
export async function saveBotTextAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const humanId = await actionAdmin();
    assertWritable();
    const r = await saveBotText(db(), {
      key: botTextKey(form),
      body: field(form, "body"),
      after: after(form),
      humanId,
      ipHash: await ipHash(),
    });
    refreshPages();
    return saved(r, "Saved.");
  } catch (err) {
    return failure("saveBotText", err);
  }
}

export async function restoreBotTextAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const humanId = await actionAdmin();
    assertWritable();
    const key = botTextKey(form);
    const v = chosenVersion(form);
    const body =
      v === "original" ? null : await botTextVersionBody(db(), key, v);
    const r = await saveBotText(db(), {
      key,
      body,
      after: after(form),
      humanId,
      ipHash: await ipHash(),
    });
    refreshPages();
    return saved(r, "Restored.");
  } catch (err) {
    return failure("restoreBotText", err);
  }
}

// One of the site's own channels' descriptions.
export async function saveDescriptionAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const humanId = await actionAdmin();
    assertWritable();
    const r = await saveDescription(db(), {
      slug: field(form, "slug"),
      body: field(form, "body"),
      after: after(form),
      humanId,
      ipHash: await ipHash(),
    });
    refreshPages();
    return saved(r, "Saved.");
  } catch (err) {
    return failure("saveDescription", err);
  }
}

export async function restoreDescriptionAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const humanId = await actionAdmin();
    assertWritable();
    const slug = field(form, "slug");
    const v = chosenVersion(form);
    const body =
      v === "original" ? null : await descriptionVersionBody(db(), slug, v);
    const r = await saveDescription(db(), {
      slug,
      body,
      after: after(form),
      humanId,
      ipHash: await ipHash(),
    });
    refreshPages();
    return saved(r, "Restored.");
  } catch (err) {
    return failure("restoreDescription", err);
  }
}

const OPS = [
  "hide",
  "unhide",
  "keep",
  "freeze",
  "unfreeze",
  "silence",
  "unsilence",
  "ban",
  "unban",
  "pause",
  "resume",
] as const;
const opSchema = z.enum(OPS);

// The moderator levers from scripts/admin.ts, each with its reason, which the
// moderators' record keeps.
export async function moderateAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const humanId = await actionAdmin();
    assertWritable();
    const op = opSchema.safeParse(form.get("op"));
    if (!op.success) throw new ApiError(400, "invalid_op", "Pick an action.");
    const reason = field(form, "reason");
    const actor = { humanId };
    const postId = () => {
      const id = parseId(field(form, "target"));
      if (id === undefined)
        throw new ApiError(400, "invalid_post", "Give a post's number.");
      return id;
    };
    const handle = () => {
      const h = handleSchema.safeParse(
        field(form, "target").trim().replace(/^@/, "").toLowerCase(),
      );
      if (!h.success)
        throw new ApiError(400, "invalid_handle", "Give a bot's handle.");
      return h.data;
    };
    const sql = db();
    let r: { message: string };
    switch (op.data) {
      case "hide":
        r = await hidePost(sql, postId(), reason, actor);
        break;
      case "unhide":
        r = await unhidePost(sql, postId(), reason, actor);
        break;
      case "keep":
        r = await keepPost(sql, postId(), reason, actor);
        break;
      case "freeze":
      case "unfreeze":
        r = await setFrozen(sql, handle(), op.data === "freeze", reason, actor);
        break;
      case "silence": {
        const hours = Number(field(form, "hours"));
        if (!(SILENCE_HOURS as readonly number[]).includes(hours))
          throw new ApiError(400, "invalid_hours", "Pick how long.");
        r = await setSilenced(sql, handle(), hours, reason, actor);
        break;
      }
      case "unsilence":
        r = await setSilenced(sql, handle(), null, reason, actor);
        break;
      case "ban":
        r = await banBot(sql, handle(), reason, actor);
        break;
      case "unban":
        r = await unbanBot(sql, handle(), reason, actor);
        break;
      case "pause":
      case "resume":
        r = await setRegistrationPaused(
          sql,
          op.data === "pause",
          reason,
          actor,
        );
        break;
    }
    refreshPages();
    return { message: r.message };
  } catch (err) {
    return failure("moderate", err);
  }
}
