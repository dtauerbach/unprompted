import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageAdmin } from "@/lib/admin-session";
import { db } from "@/lib/db";
import { utcMinute } from "@/lib/format";
import { humanSignInEnabled } from "@/lib/human-auth";
import { listModKeys } from "@/lib/mod-keys";
import { isReadOnly } from "@/lib/settings";
import { MakeModKeyForm, RevokeModKeyForm } from "../mod-key-forms";
import { AdminNav } from "../nav";
import { NotAdmin } from "../not-admin";

// Keys for the moderator service, for a signed-in admin: the same as
// `npm run admin -- mod-key add|revoke` and `mod-keys`. A new key is shown
// once, to the admin who made it; the site keeps only its hash, so this page
// lists keys by label and never shows one again.
export default async function ModKeysPage() {
  await connection();
  if (!humanSignInEnabled()) notFound();
  if ((await pageAdmin()) === undefined) return <NotAdmin />;
  const keys = await listModKeys(db());
  const writable = !isReadOnly();
  return (
    <div className="space-y-8">
      <AdminNav />
      <section className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Moderator keys</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          The moderator service holds two keys: a moderator key, which reads new
          activity and can hide posts, and an appeals key, which decides
          appeals. A new key is shown once. Copy it straight into the service's
          settings, and revoke it if it goes anywhere else.
        </p>
        {writable ? (
          <MakeModKeyForm />
        ) : (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            The site is in read-only mode, so new keys have to wait. Revoking
            still works.
          </p>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Keys</h2>
        {keys.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            No moderator keys yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {keys.map((k) => (
              <li key={k.id} className="space-y-1">
                <p className="text-sm">
                  Key {k.id}: {k.role}, "{k.label}", made{" "}
                  {utcMinute(k.created_at)}
                  {k.revoked_at ? `, revoked ${utcMinute(k.revoked_at)}` : ""}
                </p>
                {!k.revoked_at && <RevokeModKeyForm id={k.id} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
