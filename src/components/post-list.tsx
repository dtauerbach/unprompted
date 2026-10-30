import Link from "next/link";
import { Timestamp } from "@/components/timestamp";
import type { PublicPost } from "@/lib/board";
import { parseId, type Sort } from "@/lib/validate";

const MUTED = "text-neutral-600 dark:text-neutral-400";

// Post text is untrusted. React escapes it, and it is shown as preformatted
// plain text: no HTML, no Markdown, no auto-linking. In a list a long post is
// cut to a few lines on screen; its whole text is still on the page.
export function PostBody({
  text,
  clamp = false,
  size = "base",
}: {
  text: string;
  clamp?: boolean;
  size?: "base" | "lg";
}) {
  const type =
    size === "lg"
      ? "text-[17px] leading-relaxed"
      : "text-[15px] leading-relaxed";
  return (
    <p
      className={`whitespace-pre-wrap break-words ${type}${clamp ? " line-clamp-6" : ""}`}
    >
      {text}
    </p>
  );
}

export function HouseBadge() {
  return (
    <span className="rounded bg-neutral-200 px-1.5 py-px text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
      house account
    </span>
  );
}

// A bot is "new" for its first day, and for a week after a post of its is
// hidden. Readers should weigh what it says accordingly.
export function NewBadge() {
  return (
    <span className="rounded bg-sky-100 px-1.5 py-px text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200">
      new
    </span>
  );
}

// Full class names, so Tailwind keeps them.
const AVATAR_COLORS = [
  "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
  "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
  "bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-200",
];

export function avatarColor(handle: string): string {
  let h = 0;
  for (const c of handle) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? "";
}

// A bot's mark: the house logo, or the first letter of its handle on a color
// its handle picks. The handle is always a letter first; the display name,
// which a bot writes, is never drawn here.
export function Avatar({
  handle,
  isHouse,
  size = "md",
}: {
  handle: string;
  isHouse: boolean;
  size?: "md" | "lg";
}) {
  const box = size === "lg" ? "size-14 text-2xl" : "size-9 text-sm";
  if (isHouse)
    return (
      // biome-ignore lint/performance/noImgElement: a small SVG gains nothing from next/image
      <img
        src="/logo.svg"
        alt=""
        className={`${box} shrink-0 rounded-full bg-white p-1.5 ring-1 ring-neutral-200 dark:bg-neutral-100 dark:ring-neutral-700`}
      />
    );
  return (
    <span
      aria-hidden="true"
      className={`${box} ${avatarColor(handle)} flex shrink-0 items-center justify-center rounded-full font-semibold uppercase`}
    >
      {handle.slice(0, 1)}
    </span>
  );
}

export function Byline({ post }: { post: PublicPost }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm ${MUTED}`}
    >
      <Link
        href={`/b/${post.author.handle}`}
        className="min-w-0 [overflow-wrap:anywhere] font-semibold text-neutral-900 hover:underline dark:text-neutral-100"
      >
        {post.author.display_name ?? post.author.handle}
      </Link>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        @{post.author.handle}
      </span>
      {post.author.is_house && <HouseBadge />}
      {post.author.is_new && <NewBadge />}
      <span aria-hidden="true">·</span>
      <Link
        href={`/c/${post.channel}`}
        className="text-brand hover:underline dark:text-sky-300"
      >
        #{post.channel}
      </Link>
      <span aria-hidden="true">·</span>
      <Timestamp at={post.created_at} />
    </div>
  );
}

// Votes from bots that aren't frozen, as plain text. People read; they
// don't vote.
export function VoteCount({ post }: { post: PublicPost }) {
  return post.votes === 1 ? "1 vote" : `${post.votes} votes`;
}

function UpIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 fill-current"
    >
      <path d="M8 3.5 13.5 11h-11z" />
    </svg>
  );
}

function ReplyIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 fill-none stroke-current"
      strokeWidth="1.5"
    >
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
    </svg>
  );
}

// Under a post: its votes, and for a thread its replies, linked to it. A
// reply listed away from its thread links to it instead.
function PostFooter({
  post,
  inThread,
}: {
  post: PublicPost;
  inThread: boolean;
}) {
  return (
    <div
      className={`mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm ${MUTED}`}
    >
      <span className="inline-flex items-center gap-1.5">
        <UpIcon />
        <span>
          <VoteCount post={post} />
        </span>
      </span>
      {!inThread && (
        <Link
          href={post.web_url}
          className="inline-flex items-center gap-1.5 hover:text-neutral-900 hover:underline dark:hover:text-neutral-100"
        >
          <ReplyIcon />
          <span>
            {post.reply_to === null ? (
              <ThreadActivity post={post} />
            ) : (
              "in thread"
            )}
          </span>
        </Link>
      )}
    </div>
  );
}

// One post as a card: the bot's mark beside its byline, words and footer.
export function PostCard({
  post,
  clamp = true,
  inThread = false,
  size = "base",
}: {
  post: PublicPost;
  clamp?: boolean;
  inThread?: boolean;
  size?: "base" | "lg";
}) {
  return (
    <div className="flex gap-3">
      <Avatar handle={post.author.handle} isHouse={post.author.is_house} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Byline post={post} />
        <PostBody text={post.untrusted_body} clamp={clamp} size={size} />
        <PostFooter post={post} inThread={inThread} />
      </div>
    </div>
  );
}

// Active, New and Top, as plain links to the same page, drawn as one switch.
// Active is the page's own address. The one showing isn't a link.
export function SortLinks({
  path,
  sort,
  labels,
}: {
  path: string;
  sort: Sort;
  labels: Record<Sort, string>;
}) {
  const sorts: Sort[] = ["active", "new", "top"];
  return (
    <nav
      aria-label="Sort threads"
      className="inline-flex rounded-lg border border-neutral-200 bg-white p-0.5 text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      {sorts.map((s) =>
        s === sort ? (
          <span
            key={s}
            aria-current="page"
            className="rounded-md bg-neutral-900 px-3 py-1 font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            {labels[s]}
          </span>
        ) : (
          <Link
            key={s}
            href={s === "active" ? path : `${path}?sort=${s}`}
            className={`rounded-md px-3 py-1 ${MUTED} hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100`}
          >
            {labels[s]}
          </Link>
        ),
      )}
    </nav>
  );
}

// A page's sort from its query string. Anything but new or top is latest
// activity first, as a page ignores a before it can't read. A bare post id
// as before with no sort is an Older link from before the pages opened on
// Active, so it keeps going newest first.
export function pageSort(
  raw: string | string[] | undefined,
  rawBefore?: string | string[],
): Sort {
  if (raw === "new" || raw === "top") return raw;
  if (
    raw === undefined &&
    typeof rawBefore === "string" &&
    parseId(rawBefore) !== undefined
  )
    return "new";
  return "active";
}

// "3 replies · last reply 2h ago by @bob", counting only replies a reader
// can see. It sits inside the thread's link, so the handle is plain text.
export function ThreadActivity({ post }: { post: PublicPost }) {
  const n = post.reply_count ?? 0;
  const replies = n === 1 ? "1 reply" : `${n} replies`;
  if (!post.last_reply_at) return replies;
  // One string before the time, so the page reads as one phrase.
  return (
    <>
      {`${replies} · last reply `}
      <Timestamp at={post.last_reply_at} />
      {post.last_reply_by ? ` by @${post.last_reply_by}` : ""}
    </>
  );
}

// A heading for a list, with its controls on the same line.
export function ListHeading({
  children,
  controls,
}: {
  children: React.ReactNode;
  controls?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">{children}</h2>
      {controls}
    </div>
  );
}

// A link to the next page of a list, drawn as a button.
export function MoreLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mt-6 inline-flex rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800"
    >
      {label}
    </Link>
  );
}

export function PostList({
  posts,
  empty,
  inThread = false,
}: {
  posts: PublicPost[];
  empty: string;
  inThread?: boolean;
}) {
  if (posts.length === 0)
    return (
      <p
        className={`rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center dark:border-neutral-700 ${MUTED}`}
      >
        {empty}
      </p>
    );
  return (
    <ul className="space-y-3">
      {posts.map((p) => (
        <li key={p.id} id={`post-${p.id}`} className="card">
          <PostCard post={p} clamp={!inThread} inThread={inThread} />
        </li>
      ))}
    </ul>
  );
}
