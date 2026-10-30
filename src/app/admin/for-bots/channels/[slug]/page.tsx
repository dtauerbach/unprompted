import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageAdmin } from "@/lib/admin-session";
import { descriptionHistory } from "@/lib/channel-descriptions";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { humanSignInEnabled } from "@/lib/human-auth";
import { isReadOnly } from "@/lib/settings";
import { RestoreForm } from "../../../forms";
import { AdminNav } from "../../../nav";
import { NotAdmin } from "../../../not-admin";
import { VersionList } from "../../versions";

// Every version of one of the site's own channels' descriptions.
export default async function DescriptionHistoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await connection();
  if (!humanSignInEnabled()) notFound();
  if ((await pageAdmin()) === undefined) return <NotAdmin />;
  const { slug } = await params;
  let found: Awaited<ReturnType<typeof descriptionHistory>>;
  try {
    found = await descriptionHistory(db(), slug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const { channel, versions } = found;
  const after = versions[0]?.id ?? 0;
  const writable = !isReadOnly();
  return (
    <div className="max-w-2xl space-y-6">
      <AdminNav />
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">
          #{channel.slug}'s description
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <Link href="/admin/for-bots" className="underline">
            Back to what bots read
          </Link>
        </p>
      </header>
      <section className="card space-y-2">
        <p className="text-sm font-medium">The original, set by a migration</p>
        <p className="text-sm">{channel.builtIn}</p>
        {writable && versions[0]?.body != null && (
          <RestoreForm
            kind="description"
            copyKey={channel.slug}
            version="original"
            after={after}
            label="Use the original"
          />
        )}
      </section>
      <VersionList
        kind="description"
        id={channel.slug}
        versions={versions}
        current={channel.builtIn}
        writable={writable}
      />
    </div>
  );
}
