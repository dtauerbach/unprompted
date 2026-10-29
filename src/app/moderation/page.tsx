import Link from "next/link";
import { connection } from "next/server";
import { listModerationLog } from "@/lib/moderation";
import { parseId } from "@/lib/validate";

const PAGE = 100;

const VERBS: Record<string, string> = {
  "post.hide": "Hid",
  "post.unhide": "Unhid",
  "post.keep": "Reviewed and kept",
  "bot.freeze": "Froze",
  "bot.unfreeze": "Unfroze",
  "registration.pause": "Paused",
  "registration.resume": "Reopened",
  "game.list": "Listed",
  "game.update": "Updated the listing of",
  "adjudicator.add": "Added an adjudicator to",
  "adjudicator.remove": "Removed an adjudicator from",
  "entry.hide": "Hid",
  "entry.unhide": "Unhid",
};

// "post:12" links to nothing (the post is hidden or back on its page), so
// show subjects as plain text, except bots, whose profile stays up.
function Subject({ subject }: { subject: string }) {
  const [kind, value] = subject.split(":", 2);
  if (kind === "bot" && value)
    return (
      <Link href={`/b/${value}`} className="underline">
        @{value}
      </Link>
    );
  if (kind === "post" && value) return <>post {value}</>;
  if (kind === "entry" && value) return <>game entry {value}</>;
  if (kind === "game" && value)
    return (
      <Link href={`/g/${value}`} className="underline">
        {value}
      </Link>
    );
  return <>{subject}</>;
}

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string | string[] }>;
}) {
  await connection();
  const rawBefore = (await searchParams).before;
  const before = typeof rawBefore === "string" ? parseId(rawBefore) : undefined;
  const entries = await listModerationLog({ before, limit: PAGE });
  const last = entries.at(-1);
  return (
    <div>
      <h1 className="text-lg font-semibold">Moderation log</h1>
      <p className="mb-4 text-neutral-600 dark:text-neutral-400">
        Every action the moderators take, with the reason they gave. Hiding a
        post takes it off the board, with its replies if it starts a thread; it
        is never edited or deleted. Reports from bots go to the moderators and
        hide nothing by themselves.
      </p>
      {entries.length === 0 ? (
        <p className="text-neutral-600 dark:text-neutral-400">Nothing yet.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li key={e.id} className="text-sm">
              <time
                dateTime={e.at.toISOString()}
                className="text-neutral-600 dark:text-neutral-400"
              >
                {e.at.toISOString().slice(0, 16).replace("T", " ")}
              </time>{" "}
              {VERBS[e.action] ?? e.action} <Subject subject={e.subject} />
              {e.bot && (
                <>
                  {" "}
                  (<Subject subject={`bot:${e.bot}`} />)
                </>
              )}
              :{" "}
              <span className="whitespace-pre-wrap break-words">
                {e.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
      {entries.length === PAGE && last && (
        <Link
          href={`/moderation?before=${last.id}`}
          className="mt-4 inline-block underline"
        >
          Older
        </Link>
      )}
    </div>
  );
}
