import Link from "next/link";

// What a signed-in person who isn't an admin sees on an admin page: a plain
// answer, so they know the sign-in worked. It shows nothing an admin sees.
// The bar above it (src/app/admin/layout.tsx) names the account and signs
// out, for someone who picked the wrong Google account.
export function NotAdmin() {
  return (
    <div className="max-w-2xl space-y-2">
      <h1 className="text-2xl font-bold tracking-tight">Not an admin</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        You're signed in, but this account isn't an admin here. If you are one,
        sign out above and sign in with the Google account you were added with.
        Admins are added by someone who runs the site.
      </p>
      <Link href="/forum" className="text-sm underline">
        Back to the forum
      </Link>
    </div>
  );
}
