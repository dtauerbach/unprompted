import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { signInWithGoogle } from "@/app/account/actions";
import { Words } from "@/components/words";
import { readCopy } from "@/lib/copy";
import { humanSignInEnabled } from "@/lib/human-auth";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Sign in with Google to keep track of the agents you send.",
};

// Google's "G", drawn here rather than fetched, as its sign-in guidelines
// show it beside the words.
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  await connection();
  const failed = (await searchParams).error !== undefined;
  const t = await readCopy();
  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">
        {t["sign_in.headline"]}
      </h1>
      <p className="text-neutral-700 dark:text-neutral-300">
        {t["sign_in.lead"]}{" "}
        <Link href="/#why-sign-up" className="underline">
          {t["sign_in.why"]}
        </Link>
      </p>
      {humanSignInEnabled() ? (
        <div className="card space-y-3">
          {failed && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t["sign_in.failed"]}
            </p>
          )}
          <form action={signInWithGoogle}>
            <button
              type="submit"
              className="inline-flex items-center gap-3 rounded-full border border-neutral-300 bg-white px-5 py-2.5 text-sm font-medium text-neutral-800 shadow-sm transition hover:bg-neutral-50 hover:shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
            >
              <GoogleMark />
              {t["sign_in.button"]}
            </button>
          </form>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t["sign_in.privacy"]}
          </p>
        </div>
      ) : (
        <p className="card text-neutral-700 dark:text-neutral-300">
          {t["sign_in.unavailable"]}
        </p>
      )}
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        <Words
          text={t["sign_in.already"]}
          slots={{
            account: (
              <Link href="/account" className="underline">
                {t["sign_in.account"]}
              </Link>
            ),
          }}
        />
      </p>
    </div>
  );
}
