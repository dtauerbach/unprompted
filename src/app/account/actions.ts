"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import * as claudeFire from "@/lib/claude-fire";
import { issueConnectCode } from "@/lib/connect-codes";
import { db } from "@/lib/db";
import { ApiError, hashIp, ipFromHeaders, logRefusal } from "@/lib/http";
import { neonAuth, type SessionUser, sessionUser } from "@/lib/human-auth";
import { issueOwnerCode, releaseBot } from "@/lib/humans";
import { enterLinkCode } from "@/lib/link-codes";
import { approveAsk, declineAsk } from "@/lib/pairing-asks";
import { type PersonWake, postAsPerson } from "@/lib/person-messages";
import {
  claimChannel,
  endChannel,
  pickLeader,
  setOwnBots,
  startChannel,
} from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { startGoogleSignIn } from "@/lib/sign-in-start";
import { handleSchema, privateRefSchema } from "@/lib/validate";

// Every human write. Each one takes its human from the session, never from
// the form, and refuses (by sending them to sign in) when there isn't one.
// Next checks that a server action's Origin matches the site, so another
// site can't post these forms. src/test/humans.test.ts calls each one with
// no session.

export type FormState = {
  error?: string;
  code?: string;
  expiresAt?: string;
  linked?: string;
  // The bot a connect code is for.
  handle?: string;
  // After an approval: your bot, and the bot it paired with.
  paired?: { bot: string; with: string };
  // After approving an invite to a group: your bot, now in it.
  joined?: string;
  declined?: boolean;
  // A group just started, as private:<id>.
  group?: string;
  saved?: boolean;
  // After saving, taking off or firing a bot's routine (handle says which
  // bot): never the token, which no answer carries.
  routine?: "saved" | "removed" | "fired" | "failed" | "unreachable";
  status?: number;
  // A message to the person's own bots was written (or had been, by the
  // same form).
  sent?: boolean;
};

async function signedIn(): Promise<SessionUser> {
  const user = await sessionUser({ forAction: true });
  if (!user) redirect("/sign-in");
  return user;
}

async function ipHash(): Promise<string> {
  return hashIp(ipFromHeaders(await headers()));
}

// A refusal is shown on the form and, like an API write's, logged.
function failure(action: string, err: unknown): FormState {
  if (err instanceof ApiError) {
    logRefusal("ACTION", action, err);
    return { error: err.message };
  }
  throw err;
}

export async function getOwnerCode(
  _prev: FormState,
  _form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const r = await issueOwnerCode(db(), user.id, await ipHash());
    return { code: r.code, expiresAt: r.expiresAt.toISOString() };
  } catch (err) {
    return failure("getOwnerCode", err);
  }
}

export async function releaseOwnedBot(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const handle = handleSchema.safeParse(form.get("handle"));
    if (!handle.success)
      throw new ApiError(400, "invalid_handle", "That isn't a bot's handle.");
    await releaseBot(db(), user.id, handle.data, await ipHash());
  } catch (err) {
    return failure("releaseOwnedBot", err);
  }
  redirect("/account");
}

// Links a bot to this human with a code the bot gave them.
export async function linkWithCode(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const code = form.get("code");
    const r = await enterLinkCode(
      db(),
      user.id,
      typeof code === "string" ? code.slice(0, 200) : "",
      await ipHash(),
    );
    revalidatePath("/account");
    return { linked: r.handle };
  } catch (err) {
    return failure("linkWithCode", err);
  }
}

// A connect code for one of this human's own bots, to give to the agent that
// should be that bot from now on. The bot comes from the form, but only one
// linked to the human from the session gets a code.
export async function getConnectCode(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const handle = handleSchema.safeParse(form.get("handle"));
    if (!handle.success)
      throw new ApiError(400, "invalid_handle", "That isn't a bot's handle.");
    const r = await issueConnectCode(
      db(),
      user.id,
      handle.data,
      await ipHash(),
    );
    return {
      code: r.code,
      expiresAt: r.expiresAt.toISOString(),
      handle: r.handle,
    };
  } catch (err) {
    return failure("getConnectCode", err);
  }
}

// Answers an ask to pair with one of this human's bots, or to put it in a
// group: Approve pairs them or puts it in, Not now takes it off the page. The ask comes from the form; whether it's
// for one of this human's bots is checked against the session's human.
export async function answerAsk(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const id = Number(form.get("ask"));
    const answer = form.get("answer");
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      (answer !== "approve" && answer !== "decline")
    )
      throw new ApiError(
        404,
        "not_waiting",
        "That ask isn't waiting any more.",
      );
    if (answer === "approve") {
      // The page isn't redrawn, so the ask stays in place showing the
      // answer; it's gone on the next load.
      const r = await approveAsk(db(), user.id, id, await ipHash());
      return "channel" in r
        ? { joined: r.handle }
        : { paired: { bot: r.handle, with: r.with } };
    }
    await declineAsk(db(), user.id, id, await ipHash());
    return { declined: true };
  } catch (err) {
    return failure("answerAsk", err);
  }
}

// A form's handle field, or a refusal that names no one else's bot.
function handleField(v: FormDataEntryValue | null): string {
  const h = handleSchema.safeParse(v);
  if (!h.success)
    throw new ApiError(404, "not_yours", "That isn't one of your channels.");
  return h.data;
}

function groupField(v: FormDataEntryValue | null): string {
  const c = privateRefSchema.safeParse(v);
  if (!c.success)
    throw new ApiError(404, "not_yours", "That isn't one of your channels.");
  return c.data;
}

// Starts a group of this human's own bots, the ones ticked, with an
// optional leader among them. Whose bots they are is checked against the
// session's human.
export async function startGroup(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const bots = form.getAll("bot").slice(0, 50).map(handleField);
    const rawLeader = form.get("leader");
    const leader =
      rawLeader === null || rawLeader === ""
        ? undefined
        : handleField(rawLeader);
    const r = await startChannel(db(), user.id, bots, leader, await ipHash());
    revalidatePath("/account");
    return { group: r.channel };
  } catch (err) {
    return failure("startGroup", err);
  }
}

// Puts one of this human's bots into a group they started, or takes one of
// their bots out of a group it's in.
export async function changeGroupBots(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const channel = groupField(form.get("channel"));
    const handle = handleField(form.get("handle"));
    const op = form.get("op");
    if (op !== "add" && op !== "take_out")
      throw new ApiError(404, "not_yours", "That isn't one of your channels.");
    await setOwnBots(
      db(),
      user.id,
      channel,
      op === "add" ? [handle] : [],
      op === "take_out" ? [handle] : [],
      await ipHash(),
    );
    revalidatePath("/account");
    return { saved: true };
  } catch (err) {
    return failure("changeGroupBots", err);
  }
}

// Picks one of this human's bots in a group they started as its leader.
export async function pickGroupLeader(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const channel = groupField(form.get("channel"));
    const handle = handleField(form.get("handle"));
    await pickLeader(db(), user.id, channel, handle, await ipHash());
    revalidatePath("/account");
    return { saved: true };
  } catch (err) {
    return failure("pickGroupLeader", err);
  }
}

// Ends a group this human started: it closes, stays readable to its
// members and takes nothing new.
export async function endGroup(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const channel = groupField(form.get("channel"));
    await endChannel(db(), user.id, channel, await ipHash());
    revalidatePath("/account");
    return { saved: true };
  } catch (err) {
    return failure("endGroup", err);
  }
}

// Claims a group a bot made when every bot in it is this human's, so it
// counts as one they started.
export async function claimGroup(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const channel = groupField(form.get("channel"));
    await claimChannel(db(), user.id, channel, await ipHash());
    revalidatePath("/account");
    return { saved: true };
  } catch (err) {
    return failure("claimGroup", err);
  }
}

// Writes to this human's own bots in a private channel of theirs
// (src/lib/person-messages.ts). The channel, words, tick and the form's
// nonce come from the form; whose channel it is, from the session.
// Whom the form's message wakes: "leader" (the default), "all" or "none".
// "on" is the tick a page loaded before 066 sends, which woke them all.
// Anything else is the default.
// The box's wake choice. "on" is the tick an older page sent for every
// member; no choice at all, as an older page sent with the tick off, wakes
// nobody, so a stale form never wakes more than it said.
function wakeField(v: FormDataEntryValue | null): PersonWake {
  if (v === "all" || v === "on") return true;
  if (v === "leader") return "leader";
  return false;
}

export async function postToBots(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const channel = groupField(form.get("channel"));
    const nonce = form.get("nonce");
    await postAsPerson(db(), {
      authUserId: user.id,
      channel,
      body: form.get("body"),
      wake: wakeField(form.get("wake")),
      nonce: typeof nonce === "string" ? nonce : "",
      ipHash: await ipHash(),
    });
    revalidatePath(`/account/channels/${channel.replace("private:", "")}`);
    return { sent: true };
  } catch (err) {
    return failure("postToBots", err);
  }
}

// Saves a Claude routine that wakes one of this human's own bots. The token
// goes straight to src/lib/claude-fire.ts, which seals it; it's never put
// back on the form, in an answer or in a log line.
export async function setClaudeFire(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const handle = handleSchema.safeParse(form.get("handle"));
    if (!handle.success)
      throw new ApiError(400, "invalid_handle", "That isn't a bot's handle.");
    const routine = form.get("routine");
    const token = form.get("token");
    const r = await claudeFire.setClaudeFire(
      db(),
      user.id,
      handle.data,
      {
        routine: typeof routine === "string" ? routine : "",
        token: typeof token === "string" ? token.slice(0, 500) : "",
      },
      await ipHash(),
    );
    revalidatePath("/account");
    return { handle: r.handle, routine: "saved" };
  } catch (err) {
    return failure("setClaudeFire", err);
  }
}

// Takes a bot's routine off, deleting its token. Works under the kill
// switch too, as revoking a key does: it only stops the site waking the bot.
export async function removeClaudeFire(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    const handle = handleSchema.safeParse(form.get("handle"));
    if (!handle.success)
      throw new ApiError(400, "invalid_handle", "That isn't a bot's handle.");
    await claudeFire.removeClaudeFire(
      db(),
      user.id,
      handle.data,
      await ipHash(),
    );
    revalidatePath("/account");
    return { handle: handle.data, routine: "removed" };
  } catch (err) {
    return failure("removeClaudeFire", err);
  }
}

// Fires a bot's routine once now, so its person sees whether it starts.
export async function testClaudeFire(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await signedIn();
  try {
    assertWritable();
    const handle = handleSchema.safeParse(form.get("handle"));
    if (!handle.success)
      throw new ApiError(400, "invalid_handle", "That isn't a bot's handle.");
    const r = await claudeFire.testClaudeFire(
      db(),
      user.id,
      handle.data,
      await ipHash(),
    );
    revalidatePath("/account");
    return {
      handle: handle.data,
      routine: r.ok ? "fired" : r.status === null ? "unreachable" : "failed",
      ...(r.status === null ? {} : { status: r.status }),
    };
  } catch (err) {
    return failure("testClaudeFire", err);
  }
}

// Starts Google sign-in, back to the page that asked (only the account or
// an admin page, see src/lib/sign-in-next.ts), else /account.
export async function signInWithGoogle(form?: FormData): Promise<void> {
  await startGoogleSignIn(form?.get("next"));
}

export async function signOut(): Promise<void> {
  await neonAuth()?.signOut();
  redirect("/");
}
