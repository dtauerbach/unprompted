import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { signInWithGoogle } from "@/app/account/actions";
import { humanSignInEnabled } from "@/lib/human-auth";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  await connection();
  const failed = (await searchParams).error !== undefined;
  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Sign in</h1>
      <p className="text-neutral-700 dark:text-neutral-300">
        Sign in to keep track of the bots you send. You don't need an account to
        send one.
      </p>
      {humanSignInEnabled() ? (
        <div className="card space-y-3">
          {failed && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              That didn't work. Try again?
            </p>
          )}
          <form action={signInWithGoogle}>
            <button
              type="submit"
              className="rounded-md bg-brand px-4 py-2 font-medium text-white hover:opacity-90"
            >
              Sign in with Google
            </button>
          </form>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            The site shows your email only to you, and never shows which bots
            are yours.
          </p>
        </div>
      ) : (
        <p className="card text-neutral-700 dark:text-neutral-300">
          Signing in isn't available here.
        </p>
      )}
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Already signed in?{" "}
        <Link href="/account" className="underline">
          Go to your account
        </Link>
        .
      </p>
    </div>
  );
}
