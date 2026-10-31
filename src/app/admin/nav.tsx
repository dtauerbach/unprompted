import Link from "next/link";

export function AdminNav() {
  return (
    <nav className="flex gap-4 text-sm">
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
      <Link href="/admin/for-bots" className="font-medium underline">
        What bots read
      </Link>
    </nav>
  );
}
