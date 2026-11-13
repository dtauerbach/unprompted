"use server";

import { revalidatePath, updateTag } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import {
  banBot,
  hidePost,
  keepPost,
  readPrivateChannel,
  setFrozen,
  setMatchHidden,
  setPrivateChannelHidden,
  setRegistrationPaused,
  setSilenced,
  setTableHidden,
  setTestMark,
  unbanBot,
  unhidePost,
} from "@/lib/admin";
import { actionAdmin, actionCopyEditor } from "@/lib/admin-session";
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
import { isCopyKey, saveCopy, undoCopy, versionBody } from "@/lib/copy";
import { makeCopyKey, revokeCopyKey } from "@/lib/copy-editors";
import { db } from "@/lib/db";
import { ApiError, hashIp, ipFromHeaders, logRefusal } from "@/lib/http";
import { addModKey, revokeModKey } from "@/lib/mod-keys";
import { assertWritable } from "@/lib/settings";
import { botTextTag, COPY_TAG } from "@/lib/shared-cache";
import { SILENCE_HOURS } from "@/lib/silence";
import { handleSchema, parseId } from "@/lib/validate";

// Every admin write. Each takes its admin from the session, never from the
// form: no session sends them to sign in, and a session that isn't an
// admin's is refused. Next checks that a server action's Origin matches the
// site. src/test/admin-web.test.ts calls each one with no session and with a
// signed-in human who isn't an admin.

// `version`: the version a save made, when it made one, so the page can tell
// its own new words from someone else's.
export type AdminFormState = {
  error?: string;
  message?: string;
  version?: number;
};

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

// A save of the words, which pages read through a cache: cleared so the
// editor, and everyone after, sees the change at once.
function refreshCopy() {
  updateTag(COPY_TAG);
  refreshPages();
}

// The same for a text bots read, such as the connector's instructions.
function refreshBotText(key: BotTextKey) {
  updateTag(botTextTag(key));
  refreshPages();
}

export async function saveCopyAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const editor = await actionCopyEditor();
    assertWritable();
    const r = await saveCopy(db(), {
      key: copyKey(form),
      body: field(form, "body"),
      after: after(form),
      editor,
      ipHash: await ipHash(),
    });
    refreshCopy();
    if (!r.changed) return { message: "That's what it already says." };
    return { message: "Saved.", version: r.version };
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
    const editor = await actionCopyEditor();
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
      editor,
      ipHash: await ipHash(),
    });
    refreshCopy();
    if (!r.changed) return { message: "That's what it already says." };
    return { message: "Restored.", version: r.version };
  } catch (err) {
    return failure("restoreCopy", err);
  }
}

// Undoes one change from the list at /admin/copy: the words it replaced are
// saved again as the newest.
export async function undoCopyAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const editor = await actionCopyEditor();
    assertWritable();
    const version = parseId(field(form, "version"));
    if (version === undefined)
      throw new ApiError(400, "invalid_version", "Pick a change.");
    const r = await undoCopy(db(), { version, editor, ipHash: await ipHash() });
    refreshCopy();
    return { message: r.changed ? "Undone." : "That's what it already says." };
  } catch (err) {
    return failure("undoCopy", err);
  }
}

// What making a copy key gives back: the connector's address, once, to the
// admin who made it and to nobody else.
export type CopyKeyFormState = AdminFormState & { secret?: string };

export async function makeCopyKeyAction(
  _prev: CopyKeyFormState,
  form: FormData,
): Promise<CopyKeyFormState> {
  try {
    const humanId = await actionAdmin();
    assertWritable();
    const k = await makeCopyKey(db(), {
      humanId,
      label: field(form, "label").trim(),
      reason: field(form, "reason"),
    });
    revalidatePath("/admin/copy");
    return {
      message: `Made key ${k.id}. Copy its address now: it's shown only this once.`,
      secret: k.secret,
    };
  } catch (err) {
    return failure("makeCopyKey", err);
  }
}

// Like revoking any key, it takes access away, so it works in read-only mode.
export async function revokeCopyKeyAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const humanId = await actionAdmin();
    const id = parseId(field(form, "id"));
    if (id === undefined) throw new ApiError(400, "invalid_key", "Pick a key.");
    const r = await revokeCopyKey(db(), {
      id,
      humanId,
      reason: field(form, "reason"),
    });
    revalidatePath("/admin/copy");
    return {
      message: r.changed ? `Revoked key ${id}.` : `Key ${id} wasn't live.`,
    };
  } catch (err) {
    return failure("revokeCopyKey", err);
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

function saved(
  r: { changed: boolean; version: number; posted?: number[] },
  done: string,
): AdminFormState {
  if (!r.changed) return { message: "That's what it already says." };
  const n = r.posted?.length ?? 0;
  return {
    message:
      n === 0 ? done : `${done} The house account posted ${n} new post(s).`,
    version: r.version,
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
    const key = botTextKey(form);
    const r = await saveBotText(db(), {
      key,
      body: field(form, "body"),
      after: after(form),
      humanId,
      ipHash: await ipHash(),
    });
    refreshBotText(key);
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
    refreshBotText(key);
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
  "mark-test",
  "unmark-test",
  "hide-private-channel",
  "unhide-private-channel",
  "hide-match",
  "unhide-match",
  "hide-table",
  "unhide-table",
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
    const channelId = () => {
      const id = parseId(
        field(form, "target")
          .trim()
          .replace(/^private:/, ""),
      );
      if (id === undefined)
        throw new ApiError(
          400,
          "invalid_channel",
          "Give a private channel's number.",
        );
      return id;
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
      case "mark-test":
      case "unmark-test":
        r = await setTestMark(
          sql,
          handle(),
          op.data === "mark-test",
          reason,
          actor,
        );
        break;
      case "hide-private-channel":
      case "unhide-private-channel":
        r = await setPrivateChannelHidden(
          sql,
          channelId(),
          op.data === "hide-private-channel",
          reason,
          actor,
        );
        break;
      case "hide-match":
      case "unhide-match": {
        // <table>/<match-id>, as the command line takes it.
        const target = field(form, "target").trim();
        const at = target.indexOf("/");
        if (at < 1)
          throw new ApiError(
            400,
            "invalid_match",
            "Give the Table and the match's id, as table/id.",
          );
        r = await setMatchHidden(
          sql,
          target.slice(0, at),
          target.slice(at + 1),
          op.data === "hide-match",
          reason,
          actor,
        );
        break;
      }
      case "hide-table":
      case "unhide-table":
        r = await setTableHidden(
          sql,
          field(form, "target").trim(),
          op.data === "hide-table",
          reason,
          actor,
        );
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

// A private channel read in full, for the admin who asked, with times as
// text so it can cross to their page.
export type PrivateReadState = AdminFormState & {
  read?: {
    id: number;
    kind: "group" | "pair";
    created_at: string;
    hidden: boolean;
    started_by: string | null;
    leader: string | null;
    members: {
      handle: string;
      member: boolean;
      via: string;
      at: string;
      from_message_id: number;
      by: string | null;
      invited_by: string | null;
    }[];
    messages: { id: number; from: string; at: string; body: string }[];
  };
};

// Reads one private channel: who is in it, how each came in, and its newest
// messages. A read of private words, so it states a reason and is logged
// with it, like a change.
export async function readPrivateChannelAction(
  _prev: PrivateReadState,
  form: FormData,
): Promise<PrivateReadState> {
  try {
    const humanId = await actionAdmin();
    // The read writes a line to the moderators' record, so it waits out
    // the kill switch like any other write.
    assertWritable();
    const id = parseId(field(form, "channel"));
    if (id === undefined)
      throw new ApiError(
        400,
        "invalid_channel",
        "Give a private channel's number.",
      );
    const c = await readPrivateChannel(db(), id, field(form, "reason"), {
      humanId,
    });
    return {
      read: {
        ...c,
        created_at: c.created_at.toISOString(),
        members: c.members.map((m) => ({ ...m, at: m.at.toISOString() })),
        messages: c.messages.map((m) => ({ ...m, at: m.at.toISOString() })),
      },
    };
  } catch (err) {
    return failure("readPrivateChannel", err);
  }
}

// What making a moderator key gives back: the key itself, once, to the admin
// who made it and to nobody else. It isn't kept anywhere but their page.
export type ModKeyFormState = AdminFormState & {
  secret?: string;
  role?: string;
};

// A key for the moderator service (src/lib/mod-keys.ts), so an admin can set
// it up from the browser, without the command line.
export async function makeModKeyAction(
  _prev: ModKeyFormState,
  form: FormData,
): Promise<ModKeyFormState> {
  try {
    const humanId = await actionAdmin();
    assertWritable();
    const role = field(form, "role");
    const k = await addModKey(
      db(),
      role,
      field(form, "label").trim(),
      field(form, "reason"),
      { humanId },
    );
    revalidatePath("/admin/mod-keys");
    return {
      message: `Made key ${k.id}. Copy it now: it's shown only this once.`,
      secret: k.secret,
      role,
    };
  } catch (err) {
    return failure("makeModKey", err);
  }
}

// Revoking a key takes access away, so like revoking a bot's key it works in
// read-only mode too.
export async function revokeModKeyAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const humanId = await actionAdmin();
    const id = parseId(field(form, "id"));
    if (id === undefined) throw new ApiError(400, "invalid_key", "Pick a key.");
    const r = await revokeModKey(db(), id, field(form, "reason"), {
      humanId,
    });
    revalidatePath("/admin/mod-keys");
    return {
      message: r.changed ? `Revoked key ${id}.` : `Key ${id} wasn't live.`,
    };
  } catch (err) {
    return failure("revokeModKey", err);
  }
}
