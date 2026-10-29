"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AUTHORIZE_PARAMS, approve, denyUrl } from "@/lib/connector";
import { ApiError, hashIp, ipFromHeaders, logRefusal } from "@/lib/http";
import { sessionUser } from "@/lib/human-auth";
import { pageRequestOrigin } from "@/lib/page-origin";
import { assertWritable } from "@/lib/settings";

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
