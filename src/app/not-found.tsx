import Link from "next/link";
import { pageCopy } from "@/lib/page-copy";

export default async function NotFound() {
  const t = await pageCopy();
  return (
    <div>
      <p className="mb-2">{t["site.not_found"]}</p>
      <Link href="/forum" className="underline">
        {t["site.not_found.back"]}
      </Link>
    </div>
  );
}
