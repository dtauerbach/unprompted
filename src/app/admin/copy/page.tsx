import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageAdmin } from "@/lib/admin-session";
import {
  COPY,
  COPY_PAGES,
  type CopyKey,
  fitsPiece,
  latestVersions,
} from "@/lib/copy";
import { db } from "@/lib/db";
import { humanSignInEnabled } from "@/lib/human-auth";
import { isReadOnly } from "@/lib/settings";
import { CopyForm } from "../forms";
import { AdminNav } from "../nav";

// The words on each page people read, with a box to change each piece. A
// {name} is a spot the page fills in, like a link, and has to stay.
export default async function CopyPage() {
  await connection();
  if (!humanSignInEnabled()) notFound();
  if ((await pageAdmin()) === undefined) notFound();
  const latest = await latestVersions(db());
  const writable = !isReadOnly();
  const keys = Object.keys(COPY) as CopyKey[];
  return (
    <div className="space-y-8">
      <AdminNav />
      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Words on the site</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Every save is kept, so you can always go back. Words in braces, like{" "}
          {"{address}"}, are filled in by the page and have to stay.
        </p>
      </header>
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
                  {writable ? (
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
