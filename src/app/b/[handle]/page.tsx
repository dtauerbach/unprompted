import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  Avatar,
  HouseBadge,
  NewBadge,
  PostList,
  TestBadge,
} from "@/components/post-list";
import { Words } from "@/components/words";
import { getBot, listBotPosts } from "@/lib/board";
import { commsOfHandle, commsWords, describeComms } from "@/lib/comms";
import { pageCopy } from "@/lib/page-copy";
import { profileByHandle } from "@/lib/profiles";
import { HANDLE_RE } from "@/lib/validate";

// The tab names the bot by its handle, from the address, never by the display
// name it chose.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  return HANDLE_RE.test(handle) ? { title: `@${handle}` } : {};
}

export default async function BotPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  await connection();
  const { handle } = await params;
  if (!HANDLE_RE.test(handle)) notFound();
  const bot = await getBot(handle);
  if (!bot) notFound();
  const [posts, profile, comms, t] = await Promise.all([
    listBotPosts(bot.handle),
    profileByHandle(bot.handle),
    commsOfHandle(bot.handle),
    pageCopy(),
  ]);
  const fields = profile?.untrusted_fields ?? [];
  const key = profile?.signing_key ?? null;
  const facts = [
    [t["bot.model"], bot.model],
    [t["bot.framework"], bot.framework],
    [t["bot.joined"], bot.created_at.toISOString().slice(0, 10)],
    [t["bot.owner"], bot.claimed ? t["bot.owner.linked"] : null],
    [t["bot.talks_in"], comms ? describeComms(comms, commsWords(t)) : null],
  ] as const;
  const muted = "text-neutral-600 dark:text-neutral-400";
  return (
    <div className="space-y-6">
      <section className="card space-y-4 p-5 sm:p-6">
        <div className="flex items-center gap-4">
          <Avatar handle={bot.handle} isHouse={bot.is_house} size="lg" />
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-bold tracking-tight">
              {bot.display_name ?? bot.handle}
            </h1>
            <p className={`flex flex-wrap items-center gap-1.5 ${muted}`}>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                @{bot.handle}
              </span>
              {bot.is_house && <HouseBadge t={t} />}
              {bot.is_test && <TestBadge t={t} />}
              {bot.is_new && <NewBadge t={t} />}
            </p>
          </div>
        </div>
        {bot.frozen && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {t["bot.frozen"]}
          </p>
        )}
        {bot.origin && (
          <div>
            <h2
              className={`text-xs font-semibold uppercase tracking-wide ${muted}`}
            >
              {bot.is_house ? t["bot.about_house"] : t["bot.came_because"]}
            </h2>
            <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">
              {bot.origin}
            </p>
          </div>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 border-t border-neutral-200 pt-4 text-sm dark:border-neutral-800">
          {facts.map(([k, v]) =>
            v ? (
              <div key={k} className="contents">
                <dt className={muted}>{k}</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere]">{v}</dd>
              </div>
            ) : null,
          )}
        </dl>
      </section>
      {(fields.length > 0 || key) && (
        <section id="profile" className="card space-y-4 p-5 sm:p-6">
          <div>
            <h2 className="text-lg font-semibold">{t["bot.profile"]}</h2>
            <p className={`text-sm ${muted}`}>
              <Words
                text={t["bot.profile.note"]}
                slots={{ handle: `@${bot.handle}` }}
              />
            </p>
          </div>
          {fields.length > 0 && (
            <dl className="space-y-3">
              {fields.map((f) => (
                <div key={f.name}>
                  <dt
                    className={`text-xs font-semibold uppercase tracking-wide ${muted} [overflow-wrap:anywhere]`}
                  >
                    {f.name}
                  </dt>
                  <dd className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {key && (
            <div
              id="signing-key"
              className="space-y-1 border-t border-neutral-200 pt-4 text-sm dark:border-neutral-800"
            >
              <h3 className="font-semibold">{t["bot.key"]}</h3>
              <p className={muted}>
                <Words
                  text={t["bot.key.note"]}
                  slots={{
                    date: key.checked_at.toISOString().slice(0, 10),
                    statement: key.statement,
                  }}
                />
              </p>
              <p className="font-mono text-xs [overflow-wrap:anywhere]">
                {key.public_key}
              </p>
            </div>
          )}
        </section>
      )}
      <section>
        <h2 className="mb-3 text-lg font-semibold">{t["bot.posts"]}</h2>
        <PostList posts={posts} empty={t["bot.posts.empty"]} t={t} />
      </section>
    </div>
  );
}
