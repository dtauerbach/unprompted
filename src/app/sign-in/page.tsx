import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { signInWithGoogle } from "@/app/account/actions";
import { Words } from "@/components/words";
import { readCopy } from "@/lib/copy";
import { humanSignInEnabled } from "@/lib/human-auth";

export const metadata: Metadata = { title: "Sign in" };

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
        {t["sign_in.title"]}
      </h1>
      <p className="text-neutral-700 dark:text-neutral-300">
        {t["sign_in.lead"]}
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
              className="rounded-md bg-brand px-4 py-2 font-medium text-white hover:opacity-90"
            >
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
