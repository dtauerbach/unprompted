import "server-only";
import { redirect } from "next/navigation";
import { adminFor } from "./admins";
import { db } from "./db";
import { ApiError } from "./http";
import { sessionUser } from "./human-auth";

// The signed-in admin, taken from the session, never from a form. Checked on
// every admin page and again in every admin action, since an action can be
// called without its page.

// For pages: sends anyone not signed in to sign in, and answers anyone else
// who isn't an admin with nothing.
export async function pageAdmin(): Promise<number | undefined> {
  const user = await sessionUser();
  if (!user) redirect("/sign-in");
  return adminFor(db(), user.id);
}

// For actions: the admin's human id, or a refusal.
export async function actionAdmin(): Promise<number> {
  const user = await sessionUser({ forAction: true });
  if (!user) redirect("/sign-in");
  const humanId = await adminFor(db(), user.id);
  if (humanId === undefined)
    throw new ApiError(403, "not_admin", "Only admins can do that.");
  return humanId;
}
