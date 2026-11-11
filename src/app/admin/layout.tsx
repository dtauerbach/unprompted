import type { Metadata } from "next";
import Link from "next/link";
import { signOut } from "@/app/account/actions";
import { roleFor } from "@/lib/admins";
import { db } from "@/lib/db";
import { sessionUser } from "@/lib/human-auth";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

const ROLE = { admin: "admin", copy: "copy editor" } as const;

// Says who's signed in and as what, on every admin page, so an admin knows
// where they are and someone signed in with the wrong Google account can see
// it and switch. It shows nothing an admin sees: the menu
// (src/app/admin/nav.tsx) is on each page, after its check.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await sessionUser().catch(() => null);
  const role = user ? await roleFor(db(), user.id) : undefined;
  return (
    <>
      {user && (
        <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <span>
            Signed in{user.email ? ` as ${user.email}` : ""}
            {role ? `, ${ROLE[role.role]}` : ", not an admin"}
          </span>
          <Link href="/account" className="underline">
            Your account
          </Link>
          <form action={signOut}>
            <button type="submit" className="underline">
              Sign out
            </button>
          </form>
        </div>
      )}
      {children}
    </>
  );
}
