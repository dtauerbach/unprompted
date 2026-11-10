import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageCopyEditor } from "@/lib/admin-session";
import {
  COPY,
  COPY_PAGES,
  type CopyKey,
  fitsPiece,
  latestVersions,
  mayEdit,
  recentCopyChanges,
} from "@/lib/copy";
import { listCopyKeys } from "@/lib/copy-editors";
import { db } from "@/lib/db";
import { humanSignInEnabled } from "@/lib/human-auth";
import { isReadOnly } from "@/lib/settings";
import {
  MakeCopyKeyForm,
  RevokeCopyKeyForm,
  UndoForm,
} from "../copy-key-forms";
import { savedBy, when } from "../copy-who";
import { CopyForm } from "../forms";
import { AdminNav } from "../nav";
import { NotAdmin } from "../not-admin";

const MUTED = "text-sm text-neutral-600 dark:text-neutral-400";

// The words on each page people read, with a box to change each piece. A
// {name} is a spot the page fills in, like a link, and has to stay. Copy
// editors use this page too; only admins make keys here.
export default async function CopyPage() {
  await connection();
  if (!humanSignInEnabled()) notFound();
  const editor = await pageCopyEditor();
  if (editor === undefined) return <NotAdmin />;
  const admin = editor.role === "admin";
  const [latest, changes, keys_] = await Promise.all([
    latestVersions(db()),
    recentCopyChanges(db()),
    admin ? listCopyKeys(db()) : Promise.resolve([]),
  ]);
  const writable = !isReadOnly();
  const keys = Object.keys(COPY) as CopyKey[];
  return (
    <div className="space-y-8">
      <AdminNav copyOnly={!admin} />
      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Words on the site</h1>
        <p className={MUTED}>
          Every save is kept, so you can always go back. Words in braces, like{" "}
          {"{address}"}, are filled in by the page and have to stay.
        </p>
      </header>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Recent changes</h2>
        {changes.length === 0 ? (
          <p className={MUTED}>No one has changed any words yet.</p>
        ) : (
          <ul className="space-y-3">
            {changes.map((c) => (
              <li key={c.id} className="card space-y-1">
                <p className={MUTED}>
                  <time dateTime={c.created_at.toISOString()}>
                    {when(c.created_at)}
                  </time>{" "}
                  by {savedBy(c)}:{" "}
                  <Link href={`/admin/copy/${c.key}`} className="underline">
                    {COPY[c.key].label}
                  </Link>
                </p>
                <p className="text-sm">
                  <span className="line-through opacity-70">
                    {c.before ?? COPY[c.key].text}
                  </span>
                </p>
                <p className="text-sm">{c.body ?? COPY[c.key].text}</p>
                {writable && c.latest && mayEdit(editor, c.key) && (
                  <UndoForm version={c.id} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {admin && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Keys for apps</h2>
          <p className={MUTED}>
            A key lets an app, such as your assistant, change these words as a
            copy editor: never the privacy page or the line people paste into
            their agents. Its changes are saved under your name and count
            against your hourly limit. It stops working if you stop being an
            admin.
          </p>
          {writable && <MakeCopyKeyForm />}
          {keys_.length > 0 && (
            <ul className="space-y-2">
              {keys_.map((k) => (
                <li key={k.id} className="space-y-1">
                  <p className="text-sm">
                    Key {k.id}, {k.label}, made {when(k.created_at)} by human{" "}
                    {k.human_id}
                    {k.revoked_at
                      ? `, revoked ${when(k.revoked_at)}`
                      : k.live
                        ? ""
                        : ", not working: its maker isn't an admin"}
                  </p>
                  {!k.revoked_at && <RevokeCopyKeyForm id={k.id} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {COPY_PAGES.map((p) => (
        <section key={p.page} className="space-y-4">
          <h2 className="text-xl font-semibold">
            {p.title}{" "}
            <Link
              href={p.path}
              className="text-sm font-normal text-neutral-600 underline dark:text-neutral-400"
            >
              {p.path}
            </Link>
          </h2>
          {keys
            .filter((k) => COPY[k].page === p.page)
            .map((k) => {
              const v = latest.get(k);
              // What the page shows: a version that no longer fits isn't.
              const shown =
                v?.body && fitsPiece(k, v.body) ? v.body : undefined;
              const text = shown ?? COPY[k].text;
              return (
                <div key={k} className="space-y-1">
                  <p className="text-sm font-medium">
                    {COPY[k].label}{" "}
                    <Link
                      href={`/admin/copy/${k}`}
                      className="font-normal text-neutral-600 underline dark:text-neutral-400"
                    >
                      {shown
                        ? "edited, see history"
                        : v?.body
                          ? "showing the original, see history"
                          : "history"}
                    </Link>
                  </p>
                  {writable && mayEdit(editor, k) ? (
                    <CopyForm copyKey={k} text={text} after={v?.id ?? 0} />
                  ) : (
                    <p className="text-sm">{text}</p>
                  )}
                </div>
              );
            })}
        </section>
      ))}
    </div>
  );
}
