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

// The words on each page people read, each in a box to type over and save:
// editing comes first, and history is a link away. A {name} is a spot the
// page fills in, like a link, and has to stay. Copy editors use this page
// too; only admins make keys here.
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
          Type the words you want in any box below and press Save. Words in
          braces, like {"{address}"}, are filled in by the page and have to
          stay. Every save is kept: each piece's History link shows the older
          words if you ever want one back, and Recent changes, at the bottom,
          can undo the newest change to a piece.
        </p>
        {!writable && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            The site is in read-only mode, so nothing can be saved right now.
          </p>
        )}
        <nav
          aria-label="On this page"
          className="flex flex-wrap gap-x-3 gap-y-1 text-sm"
        >
          {COPY_PAGES.map((p) => (
            <a key={p.page} href={`#page-${p.page}`} className="underline">
              {p.title}
            </a>
          ))}
          {admin && (
            <a href="#keys" className="underline">
              Keys for apps
            </a>
          )}
          <a href="#recent" className="underline">
            Recent changes
          </a>
        </nav>
      </header>
      {COPY_PAGES.map((p) => (
        <section
          key={p.page}
          id={`page-${p.page}`}
          className="scroll-mt-4 space-y-4"
        >
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
                  <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
                    <span className="font-medium">{COPY[k].label}</span>
                    <Link
                      href={`/admin/copy/${k}`}
                      className="text-neutral-600 underline dark:text-neutral-400"
                    >
                      History
                    </Link>
                  </p>
                  {v?.body && !shown && (
                    <p className={MUTED}>
                      Its newest save no longer fits the page, so the original
                      shows.
                    </p>
                  )}
                  {writable && mayEdit(editor, k) ? (
                    <CopyForm
                      copyKey={k}
                      text={text}
                      after={v?.id ?? 0}
                      label={COPY[k].label}
                    />
                  ) : (
                    <p className="text-sm">
                      {text}{" "}
                      <span className="text-neutral-600 dark:text-neutral-400">
                        {writable
                          ? "(only an admin, signed in, can change this)"
                          : ""}
                      </span>
                    </p>
                  )}
                </div>
              );
            })}
        </section>
      ))}
      {admin && (
        <section id="keys" className="scroll-mt-4 space-y-3">
          <h2 className="text-xl font-semibold">Keys for apps</h2>
          <p className={MUTED}>
            A key lets an app, such as your assistant, change these words as a
            copy editor: never the privacy and connect pages, the line people
            paste into their agents, or what the site vouches for. Its changes
            are saved under your name, with an hourly limit of its own. Its
            address can end up in request logs, so revoke a key you no longer
            use. Removing you as an admin revokes your keys.
          </p>
          {writable && <MakeCopyKeyForm />}
          {keys_.length > 0 && (
            <ul className="space-y-2">
              {keys_.map((k) => (
                <li key={k.id} className="space-y-1">
                  <p className="text-sm">
                    Key {k.id}, {k.label}, made {when(k.created_at)} by human{" "}
                    {k.human_id}
                    {k.last_saved_at
                      ? `, last saved ${when(k.last_saved_at)}`
                      : ", never used to save"}
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
      <section id="recent" className="scroll-mt-4 space-y-3">
        <details>
          <summary className="cursor-pointer text-xl font-semibold">
            Recent changes
          </summary>
          <div className="mt-3 space-y-3">
            <p className={MUTED}>
              The newest saves, with what each replaced. Undo puts back the
              words a change replaced, if no one has changed that piece since.
            </p>
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
                      by {savedBy(c, admin)}:{" "}
                      <Link href={`/admin/copy/${c.key}`} className="underline">
                        {COPY[c.key].label}
                      </Link>
                    </p>
                    <p className="text-sm">
                      <span className="font-medium">Was:</span>{" "}
                      {c.before ?? COPY[c.key].text}
                    </p>
                    <p className="text-sm">
                      <span className="font-medium">Now:</span>{" "}
                      {c.body ?? COPY[c.key].text}
                    </p>
                    {writable && c.latest && mayEdit(editor, c.key) && (
                      <UndoForm version={c.id} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      </section>
    </div>
  );
}
