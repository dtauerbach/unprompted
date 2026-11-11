import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageCopyEditor } from "@/lib/admin-session";
import { COPY, copyHistory, fitsPiece, isCopyKey, mayEdit } from "@/lib/copy";
import { db } from "@/lib/db";
import { humanSignInEnabled } from "@/lib/human-auth";
import { isReadOnly } from "@/lib/settings";
import { savedBy, when } from "../../copy-who";
import { CopyForm, RestoreForm } from "../../forms";
import { AdminNav } from "../../nav";
import { NotAdmin } from "../../not-admin";

// One piece of copy: a box with the words showing now, to type over and save,
// then every earlier version, newest first, folded away. Going back saves
// the older words again as a new version, so the history only grows.
export default async function CopyHistoryPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  await connection();
  if (!humanSignInEnabled()) notFound();
  const editor = await pageCopyEditor();
  if (editor === undefined) return <NotAdmin />;
  const { key } = await params;
  if (!isCopyKey(key)) notFound();
  const versions = await copyHistory(db(), key);
  const after = versions[0]?.id ?? 0;
  const writable = !isReadOnly() && mayEdit(editor, key);
  // What the page shows: a version that no longer fits isn't.
  const newest = versions[0]?.body ?? null;
  const fits = newest !== null && fitsPiece(key, newest);
  const text = fits ? newest : COPY[key].text;
  return (
    <div className="max-w-2xl space-y-6">
      <AdminNav copyOnly={editor.role !== "admin"} />
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{COPY[key].label}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <Link href="/admin/copy" className="underline">
            Back to all the words
          </Link>
        </p>
      </header>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Showing now</h2>
        {newest !== null && !fits && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Its newest save no longer fits the page, so the original shows.
          </p>
        )}
        {writable ? (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Type the words you want and press Save. Words in braces, like{" "}
              {"{address}"}, are filled in by the page and have to stay.
            </p>
            <CopyForm
              copyKey={key}
              text={text}
              after={after}
              label={COPY[key].label}
            />
          </>
        ) : (
          <>
            <p className="text-sm">{text}</p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {isReadOnly()
                ? "The site is in read-only mode, so nothing can be saved right now."
                : "Only an admin, signed in, can change this piece."}
            </p>
          </>
        )}
      </section>
      <details className="space-y-3">
        <summary className="cursor-pointer text-lg font-semibold">
          History
        </summary>
        <div className="mt-3 space-y-3">
          <section className="card space-y-2">
            <p className="text-sm font-medium">
              The original, built into the site
            </p>
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
                      {when(v.created_at)}
                    </time>{" "}
                    by {savedBy(v, editor.role === "admin")}
                    {i === 0
                      ? fits || v.body === null
                        ? ", showing now"
                        : ", no longer fits, so not showing"
                      : ""}
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
      </details>
    </div>
  );
}
