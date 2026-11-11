"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  CONNECT_COOKIE,
  CONNECT_COOKIE_PATH,
  CONNECT_RETURN_MINUTES,
  returnPath,
  sealReturn,
} from "@/lib/connect-return";
import {
  AUTHORIZE_PARAMS,
  approve,
  checkAuthorize,
  denyUrl,
} from "@/lib/connector";
import { ApiError, hashIp, ipFromHeaders, logRefusal } from "@/lib/http";
import { sessionUser } from "@/lib/human-auth";
import { pageRequestOrigin } from "@/lib/page-origin";
import { assertWritable } from "@/lib/settings";
import { startGoogleSignIn } from "@/lib/sign-in-start";

// The approval page's two buttons. Allowing needs no sign-in: whoever is
// signed in, if anyone, is taken from the session and never from the form.
// The form only carries the client's own request back, which is checked
// again here from scratch. src/test/humans.test.ts calls these with no
// session.

export type ApproveState = { error?: string };

function paramsOf(form: FormData): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of AUTHORIZE_PARAMS) {
    const v = form.get(k);
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function allowConnector(
  _prev: ApproveState,
  form: FormData,
): Promise<ApproveState> {
  let url: string;
  try {
    assertWritable();
    const user = await sessionUser({ forAction: true });
    url = await approve(
      paramsOf(form),
      user?.id ?? null,
      hashIp(ipFromHeaders(await headers())),
      await pageRequestOrigin(),
    );
  } catch (err) {
    if (err instanceof ApiError) {
      logRefusal("ACTION", "allowConnector", err);
      return { error: err.message };
    }
    throw err;
  }
  redirect(url);
}

export async function denyConnector(
  _prev: ApproveState,
  form: FormData,
): Promise<ApproveState> {
  let url: string;
  try {
    url = await denyUrl(paramsOf(form), await pageRequestOrigin());
  } catch (err) {
    if (err instanceof ApiError) {
      logRefusal("ACTION", "denyConnector", err);
      return { error: err.message };
    }
    throw err;
  }
  redirect(url);
}

// Signing in from the approval page: keeps the request, checked, in a cookie
// only this site can write, and starts Google sign-in back to a path that
// carries the cookie's nonce (src/lib/connect-return.ts). It writes nothing
// else and needs no session. A request that doesn't check out, or can't be
// carried, falls back to the plain sign-in page.
export async function signInToConnect(form: FormData): Promise<void> {
  const params = paramsOf(form);
  const check = await checkAuthorize(params, await pageRequestOrigin());
  const sealed = check.kind === "ok" ? sealReturn(params) : undefined;
  if (!sealed) redirect("/sign-in");
  (await cookies()).set(CONNECT_COOKIE, sealed.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: CONNECT_COOKIE_PATH,
    maxAge: CONNECT_RETURN_MINUTES * 60,
  });
  await startGoogleSignIn(returnPath(sealed.nonce));
}
