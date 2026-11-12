import { redirect } from "next/navigation";
import { neonAuth } from "./human-auth";
import { pageOrigin } from "./page-origin";
import { DEFAULT_NEXT, safeNext } from "./sign-in-next";

// Starts Google sign-in. The auth server sends the human back to next if
// it's one of the pages safeNext allows, else /account, where src/proxy.ts
// finishes it. Only server actions call this, so another site can't start it.
export async function startGoogleSignIn(next: unknown): Promise<never> {
  const auth = neonAuth();
  if (!auth) redirect("/sign-in");
  const back = safeNext(next) ?? DEFAULT_NEXT;
  const { data, error } = await auth.signIn.social({
    provider: "google",
    callbackURL: `${await pageOrigin()}${back}`,
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
