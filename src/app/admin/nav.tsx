import Link from "next/link";

export function AdminNav() {
  return (
    <nav className="flex gap-4 text-sm">
      <Link href="/admin" className="font-medium underline">
        Moderation
      </Link>
      <Link href="/admin/copy" className="font-medium underline">
        Words on the site
      </Link>
    </nav>
  );
}
