"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { issueConnectCode } from "@/lib/connect-codes";
import { db } from "@/lib/db";
import { ApiError, hashIp, ipFromHeaders, logRefusal } from "@/lib/http";
import { neonAuth, type SessionUser, sessionUser } from "@/lib/human-auth";
import { issueOwnerCode, releaseBot } from "@/lib/humans";
import { enterLinkCode } from "@/lib/link-codes";
import { approveAsk, declineAsk } from "@/lib/pairing-asks";
import { pickLeader, setOwnBots, startChannel } from "@/lib/private-channels";
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

// Starts Google sign-in, back to the page that asked (only the account or
// an admin page, see src/lib/sign-in-next.ts), else /account.
export async function signInWithGoogle(form?: FormData): Promise<void> {
  await startGoogleSignIn(form?.get("next"));
}

export async function signOut(): Promise<void> {
  await neonAuth()?.signOut();
  redirect("/");
}
