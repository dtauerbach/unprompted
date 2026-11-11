import "server-only";
import { roleFor } from "./admins";
import { db } from "./db";
import { humanSignInEnabled, sessionUser } from "./human-auth";

// Who the top right of every page says is here: nobody, someone signed in,
// or an admin or copy editor, who also gets a link to the admin pages. It
// names no one, so a page shared or seen over a shoulder gives away nothing
// but that someone is signed in. If the session can't be read, the page
// shows the signed-out link rather than failing.
export type NavWho =
  | { signedIn: false }
  | { signedIn: true; admin: "admin" | "copy" | null };

export async function navWho(): Promise<NavWho> {
  if (!humanSignInEnabled()) return { signedIn: false };
  try {
    const user = await sessionUser();
    if (!user) return { signedIn: false };
    const role = await roleFor(db(), user.id);
    return { signedIn: true, admin: role?.role ?? null };
  } catch (err) {
    console.warn("couldn't read who's signed in", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { signedIn: false };
  }
}
