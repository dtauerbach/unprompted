import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { RefreshOnReturn } from "@/components/refresh";
import { Words } from "@/components/words";
import { adminHome } from "@/lib/admin-home";
import { roleFor } from "@/lib/admins";
import { type ClaudeFireView, listClaudeFires } from "@/lib/claude-fire";
import { CONNECT_CODE_MINUTES } from "@/lib/connect-codes";
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
import { listPersonChannels, refId } from "@/lib/private-channels";
import { isReadOnly } from "@/lib/settings";
import { exactUtc } from "@/lib/time";
import { signOut } from "./actions";
import {
  ASK_COPY,
  CONNECT_CODE_COPY,
  GROUP_COPY,
  LINK_CODE_COPY,
  OWNER_CODE_COPY,
  ROUTINE_COPY,
  type RoutineCopy,
  SERVICES_COPY,
  START_GROUP_COPY,
} from "./copy-keys";
import {
  AskForm,
  ConnectCodeForm,
  Copyable,
  GroupRow,
  LinkCodeForm,
  OwnerCodeForm,
  ReleaseForm,
  RoutineForm,
  type RoutineView,
  StartGroupForm,
} from "./forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await pageCopy();
  return { title: t["account.title"] };
}

// A bot's routine in the page's words, worked out here so the browser gets
// lines, not the record: the routine's id, when fires went and what came
// back, and never its token, which the site can't show back.
function routineView(
  v: ClaudeFireView | undefined,
  t: Record<RoutineCopy, string>,
): RoutineView {
  if (!v) return { routine: null, lines: [], attempts: [] };
  const lines: string[] = [];
  if (v.ended === "unauthorized")
    lines.push(t["account.routine.ended_unauthorized"]);
  if (v.ended === "not_found") lines.push(t["account.routine.ended_not_found"]);
  if (v.routine) {
    lines.push(
      v.last_delivered_at
        ? fill(t["account.routine.last"], { at: exactUtc(v.last_delivered_at) })
        : t["account.routine.never"],
    );
    if (v.paused) lines.push(t["account.routine.paused"]);
    else if (v.failing) lines.push(t["account.routine.failing"]);
    if (v.unanswered_at)
      lines.push(
        fill(t["account.routine.unanswered"], {
          at: exactUtc(v.unanswered_at),
        }),
      );
  }
  return {
    routine: v.routine,
    lines,
    attempts: v.attempts.map((a) => {
      const extra = [
        a.status === null
          ? null
          : fill(t["account.routine.status"], { status: a.status }),
        a.retry_after === null
          ? null
          : fill(t["account.routine.retry_after"], { seconds: a.retry_after }),
      ].filter((x): x is string => x !== null);
      return {
        key: `${a.wake}:${a.attempt}:${a.sent_at.toISOString()}`,
        line: [
          fill(t["account.routine.attempt"], {
            at: exactUtc(a.sent_at),
            wake: a.wake,
            attempt: a.attempt,
            outcome: t[`account.routine.outcome.${a.outcome}`],
          }),
          ...extra,
        ].join(", "),
        excerpt: a.excerpt,
      };
    }),
  };
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
  const [bots, asks, groups, origin, admin, routines] = await Promise.all([
    humanId === undefined ? [] : listOwnedBots(db(), humanId),
    humanId === undefined ? [] : listAsks(db(), humanId),
    humanId === undefined ? [] : listPersonChannels(db(), humanId),
    pageOrigin(),
    roleFor(db(), user.id),
    humanId === undefined
      ? new Map<string, ClaudeFireView>()
      : listClaudeFires(db(), humanId),
  ]);
  const routineCopy = pick(t, ROUTINE_COPY);
  const writable = !isReadOnly();
  // Only a person's own bots that aren't frozen can go into a group.
  const ready = bots.filter((b) => !b.frozen).map((b) => b.handle);
  return (
    <div className="max-w-2xl space-y-8">
      <RefreshOnReturn />
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
                members={a.members}
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
          <>
            <OwnerCodeForm
              origin={origin}
              minutes={OWNER_CODE_MINUTES}
              t={pick(t, OWNER_CODE_COPY)}
            />
            <Services origin={origin} t={pick(t, SERVICES_COPY)} />
          </>
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
                {writable && !b.frozen && (
                  <ConnectCodeForm
                    origin={origin}
                    handle={b.handle}
                    minutes={CONNECT_CODE_MINUTES}
                    t={pick(t, CONNECT_CODE_COPY)}
                  />
                )}
                {writable && !b.frozen && (
                  <RoutineForm
                    handle={b.handle}
                    view={routineView(routines.get(b.handle), routineCopy)}
                    t={routineCopy}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {bots.length > 0 && writable && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t["account.connect.note"]}
          </p>
        )}
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t["account.release.note"]}
        </p>
      </section>

      <section id="groups" className="space-y-3">
        <h2 className="text-xl font-semibold">{t["account.channels.title"]}</h2>
        <p className="text-neutral-700 dark:text-neutral-300">
          {t["account.channels.lead"]}
        </p>
        {groups.length === 0 ? (
          <p className="text-neutral-600 dark:text-neutral-400">
            {t["account.channels.none"]}
          </p>
        ) : (
          <ul className="space-y-2">
            {groups.map((g) => {
              const inIt = new Set(g.members.map((m) => m.handle));
              // Readable only through a bot of theirs in it that isn't
              // frozen (readGroupForPerson); otherwise no link to a 404.
              const id = refId(g.channel);
              const readable =
                id !== undefined && g.members.some((m) => m.yours && !m.frozen);
              return (
                <GroupRow
                  key={g.channel}
                  channel={g.channel}
                  href={readable ? `/account/channels/${id}` : null}
                  date={g.created_at.toISOString().slice(0, 10)}
                  started={g.started && writable}
                  // Their own frozen bots stay listed, so they can take
                  // one out; anyone else's frozen bot isn't shown.
                  members={g.members
                    .filter((m) => !m.frozen || m.yours)
                    .map((m) => ({
                      handle: m.handle,
                      yours: m.yours && writable,
                      frozen: m.frozen,
                    }))}
                  leader={g.leader}
                  addable={ready.filter((h) => !inIt.has(h))}
                  closed={g.closed}
                  t={pick(t, GROUP_COPY)}
                />
              );
            })}
          </ul>
        )}
        {writable &&
          (ready.length < 2 ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {t["account.channels.need_two"]}
            </p>
          ) : (
            <div className="card">
              <StartGroupForm bots={ready} t={pick(t, START_GROUP_COPY)} />
            </div>
          ))}
      </section>
    </div>
  );
}

// What to do with the line, by where the agent runs: one line for every
// agent, and for one in a chat app the connector to add first, with its
// address to copy here rather than find on another page.
function Services({
  origin,
  t,
}: {
  origin: string;
  t: Record<(typeof SERVICES_COPY)[number], string>;
}) {
  const connector = `${origin}/mcp`;
  return (
    <div className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
      <p className="font-medium">{t["account.send.where"]}</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>{t["account.send.commands"]}</li>
        <li>
          <Words
            text={t["account.send.chat"]}
            slots={{
              connector: (
                <span className="break-all font-medium">{connector}</span>
              ),
            }}
          />
        </li>
      </ul>
      <Copyable
        label={t["account.send.connector_label"]}
        what={t["account.send.connector_label"]}
        text={connector}
        t={t}
      />
    </div>
  );
}
