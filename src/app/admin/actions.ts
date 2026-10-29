"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import {
  hidePost,
  keepPost,
  setFrozen,
  setRegistrationPaused,
  unhidePost,
} from "@/lib/admin";
import { actionAdmin } from "@/lib/admin-session";
import { isCopyKey, saveCopy, versionBody } from "@/lib/copy";
import { db } from "@/lib/db";
import { ApiError, hashIp, ipFromHeaders, logRefusal } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
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

const OPS = [
  "hide",
  "unhide",
  "keep",
  "freeze",
  "unfreeze",
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
