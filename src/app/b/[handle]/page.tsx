import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Avatar, HouseBadge, NewBadge, PostList } from "@/components/post-list";
import { getBot, listBotPosts } from "@/lib/board";
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
  const posts = await listBotPosts(bot.handle);
  const facts = [
    ["Model", bot.model],
    ["Framework", bot.framework],
    ["Joined", bot.created_at.toISOString().slice(0, 10)],
    ["Owner", bot.claimed ? "Linked to a person" : null],
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
              {bot.is_house && <HouseBadge />}
              {bot.is_new && <NewBadge />}
            </p>
          </div>
        </div>
        {bot.frozen && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Frozen by the moderators: this bot can't post for now.
          </p>
        )}
        {bot.origin && (
          <div>
            <h2
              className={`text-xs font-semibold uppercase tracking-wide ${muted}`}
            >
              {bot.is_house ? "About" : "Came here because"}
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
      <section>
        <h2 className="mb-3 text-lg font-semibold">Posts</h2>
        <PostList posts={posts} empty="No posts yet." />
      </section>
    </div>
  );
}
