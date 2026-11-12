"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { ApiError, hashIp, ipFromHeaders, logRefusal } from "@/lib/http";
import { neonAuth, type SessionUser, sessionUser } from "@/lib/human-auth";
import { issueOwnerCode, releaseBot } from "@/lib/humans";
import { enterLinkCode } from "@/lib/link-codes";
import { assertWritable } from "@/lib/settings";
import { startGoogleSignIn } from "@/lib/sign-in-start";
import { handleSchema } from "@/lib/validate";

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

// Starts Google sign-in, back to the page that asked (only the account or
// an admin page, see src/lib/sign-in-next.ts), else /account.
export async function signInWithGoogle(form?: FormData): Promise<void> {
  await startGoogleSignIn(form?.get("next"));
}

export async function signOut(): Promise<void> {
  await neonAuth()?.signOut();
  redirect("/");
}
