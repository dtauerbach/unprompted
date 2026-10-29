"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { ApiError, hashIp, ipFromHeaders, logRefusal } from "@/lib/http";
import { neonAuth, type SessionUser, sessionUser } from "@/lib/human-auth";
import { issueOwnerCode, releaseBot } from "@/lib/humans";
import { pageOrigin } from "@/lib/page-origin";
import { assertWritable } from "@/lib/settings";
import { handleSchema } from "@/lib/validate";

// Every human write. Each one takes its human from the session, never from
// the form, and refuses (by sending them to sign in) when there isn't one.
// Next checks that a server action's Origin matches the site, so another
// site can't post these forms. src/test/humans.test.ts calls each one with
// no session.

export type FormState = { error?: string; code?: string; expiresAt?: string };

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

// Starts Google sign-in. The auth server sends the human back to /account,
// where src/proxy.ts finishes it.
export async function signInWithGoogle(): Promise<void> {
  const auth = neonAuth();
  if (!auth) redirect("/sign-in");
  const { data, error } = await auth.signIn.social({
    provider: "google",
    callbackURL: `${await pageOrigin()}/account`,
  });
  const url = (data as { url?: unknown } | null)?.url;
  if (error || typeof url !== "string" || !url.startsWith("https://")) {
    // The auth server says why, often a page address it doesn't trust, and
    // the visitor only sees "didn't start", so the reason goes to the logs.
    console.warn("google sign-in didn't start", {
      status: error?.status ?? null,
      code: error?.code ?? null,
      message: error?.message ?? (error ? null : "no https address returned"),
    });
    redirect("/sign-in?error=start");
  }
  redirect(url);
}

export async function signOut(): Promise<void> {
  await neonAuth()?.signOut();
  redirect("/");
}
