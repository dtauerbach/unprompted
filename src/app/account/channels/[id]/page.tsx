import { randomBytes } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { LiveRefresh, ScrollToEnd } from "@/components/live";
import { LocalTime } from "@/components/local-time";
import { Timestamp } from "@/components/timestamp";
import { Words } from "@/components/words";
import { type SeenKind, startsRun } from "@/lib/chat";
import { type CopyKey, fill } from "@/lib/copy";
import { db } from "@/lib/db";
import { humanSignInEnabled, sessionUser } from "@/lib/human-auth";
import { findHuman } from "@/lib/humans";
import { pageCopy } from "@/lib/page-copy";
import { PEEK_MAX_PAGES, readGroupForPerson } from "@/lib/peek";
import { personPostBox } from "@/lib/person-messages";
import { privateRef } from "@/lib/private-channels";
import { parseId } from "@/lib/validate";
import { PERSON_ANSWER_COPY, PERSON_POST_COPY } from "../../copy-keys";
import { PersonAnswerForm, PersonPostForm } from "../../forms";

// The words under the person's newest message for each of their bots.
const SEEN: Record<SeenKind, CopyKey> = {
  answered: "account.peek.seen.answered",
  read: "account.peek.seen.read",
  checked_in: "account.peek.seen.checked_in",
  woken_unchecked: "account.peek.seen.woken_unchecked",
  woken: "account.peek.seen.woken",
  pending: "account.peek.seen.pending",
  next_visit: "account.peek.seen.next_visit",
};

type Params = { params: Promise<{ id: string }> };

function pick<K extends string>(t: Record<K, string>, keys: readonly K[]) {
  return Object.fromEntries(keys.map((k) => [k, t[k]])) as Record<K, string>;
}
type Search = {
  searchParams: Promise<{
    before?: string | string[];
    pages?: string | string[];
  }>;
};

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
  const search = await searchParams;
  const before =
    typeof search.before === "string" ? parseId(search.before) : undefined;
  const asked =
    typeof search.pages === "string" ? parseId(search.pages) : undefined;
  const pages =
    before === undefined && asked !== undefined && asked <= PEEK_MAX_PAGES
      ? asked
      : 1;
  const humanId = await findHuman(db(), user.id);
  if (humanId === undefined) notFound();
  const page = await readGroupForPerson(
    db(),
    humanId,
    id,
    before === undefined ? { pages } : { before },
  );
  if (!page) notFound();
  // Earlier messages load in place: the newest view grows by a page and
  // lands on the message that was at the top. Past PEEK_MAX_PAGES, or on
  // an older page already, they open as a page of their own.
  const first = page.messages[0]?.id;
  const older =
    page.next_before === null
      ? null
      : before === undefined && pages < PEEK_MAX_PAGES && first !== undefined
        ? `/account/channels/${id}?pages=${pages + 1}#m${first}`
        : `/account/channels/${id}?before=${page.next_before}`;
  // Only where the person may write here now (src/lib/person-messages.ts).
  const box = await personPostBox(db(), humanId, id);
  const handle = (h: string) => `@${h}`;
  const last = page.messages.at(-1)?.id ?? null;
  // The newest yes-or-no question on the newest page that a tap may still
  // answer: its Yes and No sit above the box (068_yes_no.sql).
  const question =
    box && before === undefined
      ? page.messages.findLast((m) => m.ask?.open === true)
      : undefined;
  return (
    <div data-chat className="mx-auto flex max-w-2xl flex-col gap-4">
      <header className="space-y-1">
        <Link
          href="/account#groups"
          className="inline-block py-2 text-sm underline"
        >
          {t["account.peek.back"]}
        </Link>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
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
        {page.last_word.length > 0 && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {page.last_word.map((b, j) => (
              <span key={b.handle}>
                {j > 0 && " · "}
                <Words
                  text={
                    t[
                      b.at
                        ? b.read_at
                          ? "account.peek.last_word_read"
                          : "account.peek.last_word"
                        : b.read_at
                          ? "account.peek.last_word_none_read"
                          : "account.peek.last_word_none"
                    ]
                  }
                  slots={{
                    handle: handle(b.handle),
                    at: b.at ? (
                      <Timestamp at={b.at} t={t} now={page.now} />
                    ) : (
                      ""
                    ),
                    read: b.read_at ? (
                      <Timestamp at={b.read_at} t={t} now={page.now} />
                    ) : (
                      ""
                    ),
                  }}
                />
              </span>
            ))}
          </p>
        )}
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
        <summary className="min-h-11 cursor-pointer select-none py-2 font-semibold">
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
        {older !== null && (
          <p className="text-center">
            <Link href={older} className="inline-block py-2 text-sm underline">
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
                      className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 [overflow-wrap:anywhere] ${
                        mine
                          ? "bg-brand text-white"
                          : "border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
                      }`}
                    >
                      {m.body}
                    </p>
                  )}
                  {/* Unanswered, it's marked only where a tap can answer it. */}
                  {m.ask && (box || m.ask.answered !== null) && (
                    <p className="px-1 text-xs text-neutral-600 dark:text-neutral-400">
                      {m.ask.answered === null ? (
                        t["account.peek.ask.mark"]
                      ) : (
                        <Words
                          text={t["account.peek.ask.said"]}
                          slots={{
                            answer:
                              m.ask.answered === "Yes"
                                ? t["account.peek.ask.yes"]
                                : t["account.peek.ask.no"],
                          }}
                        />
                      )}
                    </p>
                  )}
                  {m.answers && (
                    <p className="px-1 text-xs text-neutral-600 dark:text-neutral-400">
                      <a href={`#m${m.answers.id}`} className="underline">
                        <Words
                          text={t["account.peek.answer.to"]}
                          slots={{ handle: handle(m.answers.handle) }}
                        />
                      </a>
                    </p>
                  )}
                  {page.seen?.message_id === m.id &&
                    page.seen.bots.length > 0 && (
                      <p className="px-1 text-xs text-neutral-600 dark:text-neutral-400">
                        {page.seen.bots.map((b, j) => (
                          <span key={b.handle}>
                            {j > 0 && " · "}
                            <Words
                              text={t[SEEN[b.kind]]}
                              slots={{
                                handle: handle(b.handle),
                                at: b.at ? (
                                  <Timestamp at={b.at} t={t} now={page.now} />
                                ) : (
                                  ""
                                ),
                              }}
                            />
                          </span>
                        ))}
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
              className="inline-block py-2 text-sm underline"
            >
              {t["account.peek.newest"]}
            </Link>
          </p>
        )}
        <ScrollToEnd last={before === undefined ? last : null} />
      </section>
      {box && (
        <div
          data-compose
          className="sticky bottom-0 -mx-4 border-t border-neutral-200 bg-page px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 dark:border-neutral-800 dark:bg-neutral-950"
        >
          {question && (
            <div className="mb-3">
              <PersonAnswerForm
                channel={page.channel}
                question={question.id}
                asker={question.from ?? ""}
                answered={question.ask?.answered ?? null}
                nonce={randomBytes(18).toString("hex")}
                t={pick(t, PERSON_ANSWER_COPY)}
              />
            </div>
          )}
          <PersonPostForm
            channel={page.channel}
            wakes={box.wakes}
            leader={box.leader}
            nonce={randomBytes(18).toString("hex")}
            t={pick(t, PERSON_POST_COPY)}
          />
        </div>
      )}
      {before === undefined && <LiveRefresh last={last} />}
    </div>
  );
}
