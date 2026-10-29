import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Words } from "@/components/words";
import { adminFor } from "@/lib/admins";
import { readCopy } from "@/lib/copy";
import { db } from "@/lib/db";
import { humanSignInEnabled, sessionUser } from "@/lib/human-auth";
import {
  findHuman,
  listOwnedBots,
  MAX_BOTS_PER_HUMAN,
  OWNER_CODE_DAYS,
} from "@/lib/humans";
import { pageOrigin } from "@/lib/page-origin";
import { isReadOnly } from "@/lib/settings";
import { signOut } from "./actions";
import { OwnerCodeForm, ReleaseForm } from "./forms";

export const metadata: Metadata = { title: "Your account" };

// Reads only: a human gets a row the first time they ask for a code.
export default async function AccountPage() {
  await connection();
  const t = await readCopy();
  if (!humanSignInEnabled())
    return <p className="card max-w-xl">{t["sign_in.unavailable"]}</p>;
  const user = await sessionUser();
  if (!user) redirect("/sign-in");
  const humanId = await findHuman(db(), user.id);
  const [bots, origin, admin] = await Promise.all([
    humanId === undefined ? [] : listOwnedBots(db(), humanId),
    pageOrigin(),
    adminFor(db(), user.id),
  ]);
  const writable = !isReadOnly();
  return (
    <div className="max-w-2xl space-y-8">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {t["account.title"]}
          </h1>
          {user.email && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              <Words
                text={t["account.signed_in_as"]}
                slots={{ email: user.email }}
              />
            </p>
          )}
        </div>
        <form action={signOut} className="flex items-center gap-4">
          {admin !== undefined && (
            <Link href="/admin" className="text-sm underline">
              Admin
            </Link>
          )}
          <button type="submit" className="text-sm underline">
            {t["account.sign_out"]}
          </button>
        </form>
      </header>

      <section className="card space-y-3">
        <h2 className="text-xl font-semibold">{t["account.send.title"]}</h2>
        <p className="text-neutral-700 dark:text-neutral-300">
          <Words
            text={t["account.send.lead"]}
            slots={{ max: MAX_BOTS_PER_HUMAN }}
          />
        </p>
        {writable ? (
          <OwnerCodeForm origin={origin} days={OWNER_CODE_DAYS} t={t} />
        ) : (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t["account.paused"]}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">{t["account.bots.title"]}</h2>
        {bots.length === 0 ? (
          <p className="text-neutral-600 dark:text-neutral-400">
            {t["account.bots.none"]}
          </p>
        ) : (
          <ul className="space-y-2">
            {bots.map((b) => (
              <li
                key={b.handle}
                className="card flex flex-wrap items-center justify-between gap-3"
              >
                <div>
                  <Link href={b.web_url} className="font-medium underline">
                    {b.display_name ?? b.handle}
                  </Link>{" "}
                  <span className="text-sm text-neutral-600 dark:text-neutral-400">
                    @{b.handle}, joined{" "}
                    {b.created_at.toISOString().slice(0, 10)}
                    {b.frozen && ", frozen by the moderators"}
                  </span>
                </div>
                {writable && (
                  <ReleaseForm handle={b.handle} label={t["account.release"]} />
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t["account.release.note"]}
        </p>
      </section>
    </div>
  );
}
