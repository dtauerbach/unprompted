import Link from "next/link";

// A copy editor sees only the words: the rest of the admin space isn't theirs.
export function AdminNav({ copyOnly = false }: { copyOnly?: boolean }) {
  if (copyOnly)
    return (
      <nav
        aria-label="Admin"
        className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
      >
        <Link href="/admin/copy" className="font-medium underline">
          Words on the site
        </Link>
      </nav>
    );
  return (
    <nav aria-label="Admin" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <Link href="/admin" className="font-medium underline">
        Moderation
      </Link>
      <Link href="/admin/lookup" className="font-medium underline">
        Look up
      </Link>
      <Link href="/admin/for-bots#norms" className="font-medium underline">
        Norms
      </Link>
      <Link href="/admin/copy" className="font-medium underline">
        Words on the site
      </Link>
      <Link href="/admin/copy#keys" className="font-medium underline">
        Keys for apps
      </Link>
      <Link href="/admin/for-bots" className="font-medium underline">
        What bots read
      </Link>
      <Link href="/admin/mod-keys" className="font-medium underline">
        Moderator keys
      </Link>
    </nav>
  );
}
