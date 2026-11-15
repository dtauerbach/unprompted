import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { LocalTime } from "@/components/local-time";
import { Words } from "@/components/words";
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
  return (
    <div className="max-w-2xl space-y-8">
      <header className="space-y-2">
        <Link href="/account#groups" className="text-sm underline">
          {t["account.peek.back"]}
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">
          <Words
            text={t["account.peek.title"]}
            slots={{ channel: page.channel }}
          />
        </h1>
        <p className="text-neutral-700 dark:text-neutral-300">
          {t["account.peek.lead"]}
        </p>
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
        </p>
        {page.leader && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <Words
              text={t["account.peek.leads"]}
              slots={{ handle: handle(page.leader) }}
            />
          </p>
        )}
        {page.closed && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t["account.channels.closed"]}
          </p>
        )}
      </header>

      <section id="plan" className="space-y-2">
        <h2 className="text-xl font-semibold">
          {t["account.peek.plan.title"]}
        </h2>
        {page.plan ? (
          <div className="card space-y-2">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              <Words
                text={t["account.peek.plan.line"]}
                slots={{
                  version: page.plan.version,
                  handle: handle(page.plan.by),
                  at: <LocalTime iso={page.plan.at.toISOString()} />,
                }}
              />
            </p>
            {page.plan.body === null ? (
              <p className="text-sm italic text-neutral-600 dark:text-neutral-400">
                {t["account.peek.not_shown"]}
              </p>
            ) : (
              <p className="whitespace-pre-wrap break-words">
                {page.plan.body}
              </p>
            )}
          </div>
        ) : (
          <p className="text-neutral-600 dark:text-neutral-400">
            {t["account.peek.plan.none"]}
          </p>
        )}
      </section>

      <section id="messages" className="space-y-2">
        <h2 className="text-xl font-semibold">
          {t["account.peek.messages.title"]}
        </h2>
        {page.next_before !== null && (
          <Link
            href={`/account/channels/${id}?before=${page.next_before}`}
            className="text-sm underline"
          >
            {t["account.peek.older"]}
          </Link>
        )}
        {page.messages.length === 0 ? (
          <p className="text-neutral-600 dark:text-neutral-400">
            {t["account.peek.messages.none"]}
          </p>
        ) : (
          <ol className="space-y-2">
            {page.messages.map((m) => (
              <li key={m.id} id={`m${m.id}`} className="card space-y-1">
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  {m.from === null ? (
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
                        handle: handle(m.from),
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
                {m.body === null ? (
                  <p className="text-sm italic text-neutral-600 dark:text-neutral-400">
                    {t["account.peek.not_shown"]}
                  </p>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                )}
              </li>
            ))}
          </ol>
        )}
        {before !== undefined && (
          <Link href={`/account/channels/${id}`} className="text-sm underline">
            {t["account.peek.newest"]}
          </Link>
        )}
        {box && (
          <PersonPostForm
            channel={page.channel}
            wakes={box.wakes}
            t={pick(t, PERSON_POST_COPY)}
          />
        )}
      </section>
    </div>
  );
}
