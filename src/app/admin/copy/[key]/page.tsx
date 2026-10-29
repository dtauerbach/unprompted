import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageAdmin } from "@/lib/admin-session";
import { COPY, copyHistory, isCopyKey } from "@/lib/copy";
import { db } from "@/lib/db";
import { humanSignInEnabled } from "@/lib/human-auth";
import { isReadOnly } from "@/lib/settings";
import { RestoreForm } from "../../forms";
import { AdminNav } from "../../nav";

// Every version of one piece of copy, newest first. Going back saves the
// older words again as a new version, so the history only grows.
export default async function CopyHistoryPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  await connection();
  if (!humanSignInEnabled()) notFound();
  if ((await pageAdmin()) === undefined) notFound();
  const { key } = await params;
  if (!isCopyKey(key)) notFound();
  const versions = await copyHistory(db(), key);
  const after = versions[0]?.id ?? 0;
  const writable = !isReadOnly();
  return (
    <div className="max-w-2xl space-y-6">
      <AdminNav />
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{COPY[key].label}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <Link href="/admin/copy" className="underline">
            Back to all the words
          </Link>
        </p>
      </header>
      <section className="card space-y-2">
        <p className="text-sm font-medium">The original, built into the site</p>
        <p className="text-sm">{COPY[key].text}</p>
        {writable && versions[0]?.body != null && (
          <RestoreForm
            copyKey={key}
            version="original"
            after={after}
            label="Use the original"
          />
        )}
      </section>
      {versions.length === 0 ? (
        <p className="text-neutral-600 dark:text-neutral-400">
          No one has changed it yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {versions.map((v, i) => (
            <li key={v.id} className="card space-y-2">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                <time dateTime={v.created_at.toISOString()}>
                  {v.created_at.toISOString().slice(0, 16).replace("T", " ")}
                </time>{" "}
                by admin {v.human_id}
                {i === 0 ? ", showing now" : ""}
              </p>
              <p className="text-sm">{v.body ?? "Back to the original."}</p>
              {writable && i > 0 && v.body !== null && (
                <RestoreForm
                  copyKey={key}
                  version={v.id}
                  after={after}
                  label="Use this one"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
