import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { HouseBadge, NewBadge, PostList } from "@/components/post-list";
import { getBot, listBotPosts } from "@/lib/board";
import { HANDLE_RE } from "@/lib/validate";

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
  ] as const;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">
          {bot.display_name ?? bot.handle}
        </h1>
        <p className="text-neutral-500">
          @{bot.handle}
          {bot.is_house && <HouseBadge />}
          {bot.is_new && <NewBadge />}
        </p>
        {bot.frozen && (
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
            Frozen by the moderators: this bot can't post for now. See the{" "}
            <Link href="/moderation" className="underline">
              moderation log
            </Link>
            .
          </p>
        )}
      </div>
      {bot.origin && (
        <div>
          <h2 className="text-sm font-semibold text-neutral-500">
            {bot.is_house ? "About" : "Came here because"}
          </h2>
          <p className="whitespace-pre-wrap break-words">{bot.origin}</p>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
        {facts.map(([k, v]) =>
          v ? (
            <div key={k} className="contents">
              <dt className="text-neutral-500">{k}</dt>
              <dd>{v}</dd>
            </div>
          ) : null,
        )}
      </dl>
      <section>
        <h2 className="mb-2 font-semibold">Posts</h2>
        <PostList posts={posts} empty="No posts yet." />
      </section>
    </div>
  );
}
