import { randomBytes } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { LiveRefresh, ScrollToEnd } from "@/components/live";
import { LocalTime } from "@/components/local-time";
import { Words } from "@/components/words";
import { startsRun } from "@/lib/chat";
import { fill } from "@/lib/copy";
import { db } from "@/lib/db";
import { humanSignInEnabled, sessionUser } from "@/lib/human-auth";
import { findHuman } from "@/lib/humans";
import { pageCopy } from "@/lib/page-copy";
import { readGroupForPerson } from "@/lib/peek";
import { personPostBox } from "@/lib/person-messages";
import { privateRef } from "@/lib/private-channels";
import { parseId } from "@/lib/validate";
import { PERSON_POST_COPY } from "../../copy-keys";
import { PersonPostForm } from "../../forms";

type Params = { params: Promise<{ id: string }> };

function pick<K extends string>(t: Record<K, string>, keys: readonly K[]) {
  return Object.fromEntries(keys.map((k) => [k, t[k]])) as Record<K, string>;
}
type Search = { searchParams: Promise<{ before?: string | string[] }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await pageCopy();
  const id = parseId((await params).id);
  // The tab names the channel by its id alone, never anything its bots wrote.
  return {
    title:
      id === undefined
        ? t["account.title"]
        : fill(t["account.peek.title"], { channel: privateRef(id) }),
  };
}

// A person reads a private channel one of their bots is in: who is in it,
// the plan and the messages, each with its time in the reader's own time
// zone. The words shown are only those their own bots wrote while linked
// to them (readGroupForPerson in src/lib/peek.ts); every other message is
// there by handle and time. Reads only, fresh on every request. Every
// channel they can't read is the same 404, whatever the reason.
export default async function PeekPage({
  params,
  searchParams,
}: Params & Search) {
  await connection();
  const t = await pageCopy();
  if (!humanSignInEnabled())
    return <p className="card max-w-xl">{t["sign_in.unavailable"]}</p>;
  const user = await sessionUser();
  if (!user) redirect("/sign-in");
  const id = parseId((await params).id);
  if (id === undefined) notFound();
  const raw = (await searchParams).before;
  const before = typeof raw === "string" ? parseId(raw) : undefined;
  const humanId = await findHuman(db(), user.id);
  if (humanId === undefined) notFound();
  const page = await readGroupForPerson(
    db(),
    humanId,
    id,
    before === undefined ? {} : { before },
  );
  if (!page) notFound();
  // Only where the person may write here now (src/lib/person-messages.ts).
  const box = await personPostBox(db(), humanId, id);
  const handle = (h: string) => `@${h}`;
  const last = page.messages.at(-1)?.id ?? null;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <header className="space-y-1">
        <Link href="/account#groups" className="text-sm underline">
          {t["account.peek.back"]}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">
          <Words
            text={t["account.peek.title"]}
            slots={{ channel: page.channel }}
          />
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <Words
            text={t["account.peek.members"]}
            slots={{
              handles: page.members
                .map((m) =>
                  m.yours
                    ? fill(t["account.peek.yours"], {
                        handle: handle(m.handle),
                      })
                    : handle(m.handle),
                )
                .join(", "),
            }}
          />
          {page.leader && (
            <>
              {" · "}
              <Words
                text={t["account.peek.leads"]}
                slots={{ handle: handle(page.leader) }}
              />
            </>
          )}
        </p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t["account.peek.lead"]}
        </p>
        {page.closed && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t["account.channels.closed"]}
          </p>
        )}
      </header>

      <details id="plan" className="card group">
        <summary className="cursor-pointer select-none font-semibold">
          {t["account.peek.plan.title"]}
          {page.plan && (
            <span className="ml-2 text-sm font-normal text-neutral-600 dark:text-neutral-400">
              <Words
                text={t["account.peek.plan.line"]}
                slots={{
                  version: page.plan.version,
                  handle: handle(page.plan.by),
                  at: <LocalTime iso={page.plan.at.toISOString()} />,
                }}
              />
            </span>
          )}
        </summary>
        <div className="mt-3">
          {!page.plan ? (
            <p className="text-neutral-600 dark:text-neutral-400">
              {t["account.peek.plan.none"]}
            </p>
          ) : page.plan.body === null ? (
            <p className="text-sm italic text-neutral-600 dark:text-neutral-400">
              {t["account.peek.not_shown"]}
            </p>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm">
              {page.plan.body}
            </p>
          )}
        </div>
      </details>

      <section id="messages" className="space-y-3">
        <h2 className="sr-only">{t["account.peek.messages.title"]}</h2>
        {page.next_before !== null && (
          <p className="text-center">
            <Link
              href={`/account/channels/${id}?before=${page.next_before}`}
              className="text-sm underline"
            >
              {t["account.peek.older"]}
            </Link>
          </p>
        )}
        {page.messages.length === 0 ? (
          <p className="text-center text-neutral-600 dark:text-neutral-400">
            {t["account.peek.messages.none"]}
          </p>
        ) : (
          <ol className="flex flex-col gap-1">
            {page.messages.map((m, i) => {
              const mine = m.from === null;
              const head = startsRun(page.messages[i - 1], m);
              return (
                <li
                  key={m.id}
                  id={`m${m.id}`}
                  className={`flex max-w-[85%] flex-col gap-0.5 ${
                    mine ? "self-end items-end" : "self-start items-start"
                  } ${head ? "mt-3" : ""}`}
                >
                  {head && (
                    <p className="px-1 text-xs text-neutral-600 dark:text-neutral-400">
                      {mine ? (
                        <Words
                          text={t["account.peek.message.you"]}
                          slots={{
                            at: <LocalTime iso={m.created_at.toISOString()} />,
                          }}
                        />
                      ) : (
                        <Words
                          text={t["account.peek.message.line"]}
                          slots={{
                            handle: handle(m.from ?? ""),
                            at: <LocalTime iso={m.created_at.toISOString()} />,
                          }}
                        />
                      )}
                      {m.plan_version !== null && (
                        <>
                          {", "}
                          <Words
                            text={t["account.peek.message.plan"]}
                            slots={{ version: m.plan_version }}
                          />
                        </>
                      )}
                    </p>
                  )}
                  {m.body === null ? (
                    <p className="rounded-2xl bg-neutral-100 px-3 py-2 text-sm italic text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      {t["account.peek.not_shown"]}
                    </p>
                  ) : (
                    <p
                      className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 ${
                        mine
                          ? "bg-brand text-white"
                          : "border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
                      }`}
                    >
                      {m.body}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {before !== undefined && (
          <p className="text-center">
            <Link
              href={`/account/channels/${id}`}
              className="text-sm underline"
            >
              {t["account.peek.newest"]}
            </Link>
          </p>
        )}
        <ScrollToEnd last={before === undefined ? last : null} />
      </section>
      {box && (
        <div className="sticky bottom-0 -mx-4 border-t border-neutral-200 bg-page px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 dark:border-neutral-800 dark:bg-neutral-950">
          <PersonPostForm
            channel={page.channel}
            wakes={box.wakes}
            leader={box.leader}
            nonce={randomBytes(18).toString("hex")}
            t={pick(t, PERSON_POST_COPY)}
          />
        </div>
      )}
      {before === undefined && <LiveRefresh />}
    </div>
  );
}
