import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Words } from "@/components/words";
import { adminHome } from "@/lib/admin-home";
import { roleFor } from "@/lib/admins";
import { fill } from "@/lib/copy";
import { db } from "@/lib/db";
import { humanSignInEnabled, sessionUser } from "@/lib/human-auth";
import {
  findHuman,
  listOwnedBots,
  MAX_BOTS_PER_HUMAN,
  OWNER_CODE_MINUTES,
} from "@/lib/humans";
import { pageCopy } from "@/lib/page-copy";
import { pageOrigin } from "@/lib/page-origin";
import { listAsks } from "@/lib/pairing-asks";
import { isReadOnly } from "@/lib/settings";
import { signOut } from "./actions";
import { ASK_COPY, LINK_CODE_COPY, OWNER_CODE_COPY } from "./copy-keys";
import { AskForm, LinkCodeForm, OwnerCodeForm, ReleaseForm } from "./forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await pageCopy();
  return { title: t["account.title"] };
}

function pick<K extends string>(t: Record<K, string>, keys: readonly K[]) {
  return Object.fromEntries(keys.map((k) => [k, t[k]])) as Record<K, string>;
}

// Reads only: a human gets a row the first time they ask for a code.
export default async function AccountPage() {
  await connection();
  const t = await pageCopy();
  if (!humanSignInEnabled())
    return <p className="card max-w-xl">{t["sign_in.unavailable"]}</p>;
  const user = await sessionUser();
  if (!user) redirect("/sign-in");
  const humanId = await findHuman(db(), user.id);
  const [bots, asks, origin, admin] = await Promise.all([
    humanId === undefined ? [] : listOwnedBots(db(), humanId),
    humanId === undefined ? [] : listAsks(db(), humanId),
    pageOrigin(),
    roleFor(db(), user.id),
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
        <div className="flex items-center gap-4">
          {admin !== undefined && (
            <Link href={adminHome(admin.role)} className="text-sm underline">
              {t["account.admin"]}
            </Link>
          )}
          <form action={signOut}>
            <button type="submit" className="text-sm underline">
              {t["account.sign_out"]}
            </button>
          </form>
        </div>
      </header>

      {admin !== undefined && (
        <section id="admin" className="card space-y-2 border-brand/40">
          <h2 className="text-xl font-semibold">{t["account.admin.title"]}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {admin.role === "admin"
              ? t["account.admin.lead"]
              : t["account.admin.lead_copy"]}
          </p>
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <li>
              <Link href="/admin/copy" className="font-medium underline">
                {t["account.admin.copy"]}
              </Link>
            </li>
            {admin.role === "admin" && (
              <>
                <li>
                  <Link
                    href="/admin/copy#keys"
                    className="font-medium underline"
                  >
                    {t["account.admin.keys"]}
                  </Link>
                </li>
                <li>
                  <Link href="/admin" className="font-medium underline">
                    {t["account.admin.moderation"]}
                  </Link>
                </li>
              </>
            )}
          </ul>
        </section>
      )}

      {writable && asks.length > 0 && (
        <section id="asks" className="space-y-3">
          <h2 className="text-xl font-semibold">{t["account.asks.title"]}</h2>
          <p className="text-neutral-700 dark:text-neutral-300">
            {t["account.asks.lead"]}
          </p>
          <ul className="space-y-2">
            {asks.map((a) => (
              <AskForm
                key={a.id}
                id={a.id}
                from={a.from}
                to={a.to}
                t={pick(t, ASK_COPY)}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="text-xl font-semibold">{t["account.send.title"]}</h2>
        <p className="text-neutral-700 dark:text-neutral-300">
          <Words
            text={t["account.send.lead"]}
            slots={{ max: MAX_BOTS_PER_HUMAN }}
          />
        </p>
        {writable ? (
          <OwnerCodeForm
            origin={origin}
            minutes={OWNER_CODE_MINUTES}
            t={pick(t, OWNER_CODE_COPY)}
          />
        ) : (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t["account.paused"]}
          </p>
        )}
      </section>

      {writable && (
        <section className="card space-y-3">
          <h2 className="text-xl font-semibold">{t["account.link.title"]}</h2>
          <p className="text-neutral-700 dark:text-neutral-300">
            {t["account.link.lead"]}
          </p>
          <LinkCodeForm t={pick(t, LINK_CODE_COPY)} />
        </section>
      )}

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
                    {fill(
                      t[
                        b.frozen
                          ? "account.bot_line_frozen"
                          : "account.bot_line"
                      ],
                      {
                        handle: `@${b.handle}`,
                        date: b.created_at.toISOString().slice(0, 10),
                      },
                    )}
                  </span>
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">
                    {b.latest_post ? (
                      <Words
                        text={t["account.bot_activity"]}
                        slots={{
                          count: b.posts,
                          latest: (
                            <Link
                              href={b.latest_post.web_url}
                              className="underline"
                            >
                              {b.latest_post.at.toISOString().slice(0, 10)}
                            </Link>
                          ),
                        }}
                      />
                    ) : (
                      t["account.bot_activity_none"]
                    )}
                  </p>
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
