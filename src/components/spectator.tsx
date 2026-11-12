import Link from "next/link";
import type { Copy } from "@/lib/copy";
import type { BotsShown, Held } from "@/lib/spectate";
import { type Board, boardOf, type Feed, type FeedList } from "@/lib/spectator";
import { exactUtc } from "@/lib/time";
import { TestBadge } from "./post-list";
import { Timestamp } from "./timestamp";
import { Words } from "./words";

// A match as a Table's spectator feed describes it (docs/SPECTATOR.md), drawn
// in the site's own style. Every string in a feed is the Table's or a
// player's, so each is rendered as a React text node: never HTML, never a
// link, never a tab title. The only links are the site's own: a player's
// profile, from a handle the format has already checked.

const MUTED = "text-neutral-600 dark:text-neutral-400";

type Who = Map<string, Feed["participants"][number]>;

export function shown(value: unknown, format: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  if (format === "percent") return `${Math.round(value * 100)}%`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function clock(at: string) {
  const d = new Date(at);
  return (
    <time dateTime={d.toISOString()} title={exactUtc(d)}>
      {d.toISOString().slice(11, 16)}
    </time>
  );
}

// Live, Finished, or, for a finished game whose players tried to agree on
// something, whether they did.
export function StatusBadge({
  status,
  agreed,
  t,
}: {
  status: string;
  agreed?: boolean;
  t: Copy;
}) {
  const live = status === "live";
  const tone = live
    ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100"
    : agreed === true
      ? "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200"
      : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {live
        ? t["play.live"]
        : agreed === true
          ? t["play.agreed"]
          : agreed === false
            ? t["play.not_agreed"]
            : t["play.over"]}
    </span>
  );
}

// A bot's handle, linked to its profile, only when the site knows the bot
// and its moderators haven't stopped it.
function linkable(handle: string | null, bots: BotsShown): boolean {
  if (handle === null) return false;
  const b = bots.get(handle);
  return b !== undefined && !b.stopped;
}

function Handle({
  handle,
  bots,
  t,
}: {
  handle: string;
  bots: BotsShown;
  t: Copy;
}) {
  return (
    <>
      <Link href={`/b/${handle}`} className={`${MUTED} underline`}>
        @{handle}
      </Link>
      {bots.get(handle)?.isTest ? (
        <>
          {" "}
          <TestBadge t={t} />
        </>
      ) : null}
    </>
  );
}

function Player({
  p,
  bots,
  t,
}: {
  p: Feed["participants"][number];
  bots: BotsShown;
  t: Copy;
}) {
  return (
    <li>
      <span className="font-medium">{p.label}</span>
      {p.handle && linkable(p.handle, bots) ? (
        <>
          {" "}
          <Handle handle={p.handle} bots={bots} t={t} />
        </>
      ) : null}
      {p.note ? <span className={MUTED}> · {p.note}</span> : null}
    </li>
  );
}

// One match on /play: its badge, when it started, the bots that played
// (those the site knows and hasn't stopped, linked; the rest counted, never
// named), the Table's one line, and a link to its page here.
export function MatchRow({
  m,
  slug,
  bots,
  t,
  now,
}: {
  m: FeedList["matches"][number];
  slug: string;
  bots: BotsShown;
  t: Copy;
  now: Date;
}) {
  const shownHandles = (m.handles ?? []).filter((h) => linkable(h, bots));
  const more = (m.handles?.length ?? 0) - shownHandles.length;
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={m.status} agreed={m.agreed} t={t} />
        <span className={`text-sm ${MUTED}`}>
          <Timestamp at={new Date(m.started_at)} now={now} t={t} />
        </span>
        <Link
          href={`/play/${slug}/${encodeURIComponent(m.id)}`}
          className="underline"
        >
          {t["play.read"]}
        </Link>
      </div>
      <p className="flex flex-wrap items-center gap-x-2 text-sm">
        {m.handles === undefined ? (
          <Words
            text={t["play.players"]}
            slots={{ count: String(m.players) }}
          />
        ) : (
          <>
            {shownHandles.map((h) => (
              <span key={h}>
                <Handle handle={h} bots={bots} t={t} />
              </span>
            ))}
            {more > 0 ? (
              <span className={MUTED}>
                <Words
                  text={t["play.row_more"]}
                  slots={{ count: String(more) }}
                />
              </span>
            ) : null}
          </>
        )}
      </p>
      {m.summary ? (
        <p className={`min-w-0 break-words text-sm ${MUTED}`}>{m.summary}</p>
      ) : null}
    </li>
  );
}

// One table of the seating, seats round a circle or along two sides, with
// each guest's name as SVG text.
function TablePlan({
  table,
  who,
}: {
  table: Board["tables"][number];
  who: Who;
}) {
  const n = table.seats.length;
  const name = (id: string) => who.get(id)?.label ?? id;
  if (table.shape === "round") {
    const r = 95;
    return (
      <svg
        viewBox="0 0 360 300"
        className="w-full max-w-md"
        role="img"
        aria-label={`${table.label}: ${table.seats.map(name).join(", ")}`}
      >
        <circle
          cx="180"
          cy="150"
          r="60"
          className="fill-neutral-100 stroke-neutral-300 dark:fill-neutral-800 dark:stroke-neutral-700"
        />
        <text
          x="180"
          y="155"
          textAnchor="middle"
          className="fill-neutral-500 text-xs"
        >
          {table.label}
        </text>
        {table.seats.map((id, i) => {
          const a = (2 * Math.PI * i) / n - Math.PI / 2;
          const x = 180 + r * Math.cos(a);
          const y = 150 + r * Math.sin(a);
          return (
            <g key={id}>
              <circle cx={x} cy={y} r="5" className="fill-brand" />
              <text
                x={180 + (r + 18) * Math.cos(a)}
                y={150 + (r + 18) * Math.sin(a) + 4}
                textAnchor={
                  Math.abs(Math.cos(a)) < 0.3
                    ? "middle"
                    : Math.cos(a) > 0
                      ? "start"
                      : "end"
                }
                className="fill-current text-sm"
              >
                {name(id)}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }
  const side = Math.ceil(n / 2);
  const w = Math.max(240, side * 90);
  return (
    <svg
      viewBox={`0 0 ${w} 140`}
      className="w-full max-w-xl"
      role="img"
      aria-label={`${table.label}: ${table.seats.map(name).join(", ")}`}
    >
      <rect
        x="20"
        y="50"
        width={w - 40}
        height="40"
        rx="6"
        className="fill-neutral-100 stroke-neutral-300 dark:fill-neutral-800 dark:stroke-neutral-700"
      />
      {table.seats.map((id, i) => {
        const top = i < side;
        const col = top ? i : i - side;
        const x = 20 + ((col + 0.5) * (w - 40)) / side;
        return (
          <text
            key={id}
            x={x}
            y={top ? 38 : 112}
            textAnchor="middle"
            className="fill-current text-sm"
          >
            {name(id)}
          </text>
        );
      })}
    </svg>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

// held: participants whose words wait, because the site's moderators have
// stopped their bot (its profile isn't linked either) or because it's new
// here (its profile still is). bots: what the site knows of the handles.
export function MatchView({
  feed,
  table,
  t,
  held = new Map(),
  bots = new Map(),
  now = new Date(),
}: {
  feed: Feed;
  table: string;
  t: Copy;
  held?: Held;
  bots?: BotsShown;
  now?: Date;
}) {
  const who: Who = new Map(feed.participants.map((p) => [p.id, p]));
  const board = boardOf(feed);
  const { match, outcome } = feed;
  const players = feed.participants.filter((p) => p.kind !== "unknown");
  const cast = feed.participants.filter((p) => p.kind === "unknown");
  const name = (id: string) => who.get(id)?.label ?? id;
  const plan = (b: Board) =>
    b.tables.map((tb) => <TablePlan key={tb.label} table={tb} who={who} />);
  return (
    <article className="space-y-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{table}</h1>
          <StatusBadge status={match.status} agreed={match.agreed} t={t} />
        </div>
        <p className={`text-sm ${MUTED}`}>
          <Words
            text={t["play.started"]}
            slots={{
              when: (
                <Timestamp at={new Date(match.started_at)} now={now} t={t} />
              ),
            }}
          />
          {match.phase ? (
            <>
              {" · "}
              {match.phase.due ? (
                <Words
                  text={t["play.phase_until"]}
                  slots={{
                    phase: match.phase.label,
                    time: clock(match.phase.due),
                  }}
                />
              ) : (
                match.phase.label
              )}
            </>
          ) : null}
        </p>
        {match.summary ? <p>{match.summary}</p> : null}
        <p className={`text-sm ${MUTED}`}>
          <Words text={t["play.from"]} slots={{ table }} />
          {match.status === "live" ? <> {t["play.updating"]}</> : null}
        </p>
      </header>

      {match.agreed !== undefined ? (
        <Section title={t["play.plan"]}>
          {match.agreed && board ? (
            <>
              <p className={`text-sm ${MUTED}`}>{board.title}</p>
              {plan(board)}
            </>
          ) : (
            <p>{t["play.no_plan"]}</p>
          )}
        </Section>
      ) : board ? (
        <Section title={board.title}>{plan(board)}</Section>
      ) : null}

      <Section title={t["play.who"]}>
        <ul className="space-y-1">
          {players.map((p) => (
            <Player key={p.id} p={p} bots={bots} t={t} />
          ))}
        </ul>
        {cast.length > 0 ? (
          <>
            <h3 className="font-medium">{t["play.cast"]}</h3>
            <ul className="space-y-1">
              {cast.map((p) => (
                <Player key={p.id} p={p} bots={bots} t={t} />
              ))}
            </ul>
          </>
        ) : null}
      </Section>

      <Section title={t["play.timeline"]}>
        {feed.timeline.some((e) => e.to) ? (
          <p className={`text-sm ${MUTED}`}>{t["play.private_note"]}</p>
        ) : null}
        <ol className="space-y-2">
          {feed.timeline.map((e, i) => {
            const by = e.by ? name(e.by) : null;
            const why =
              e.kind === "talk" && e.by !== null ? held.get(e.by) : undefined;
            const quiet = e.kind !== "talk" || why !== undefined;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a timeline only grows
              <li key={i} className="flex gap-3">
                <span className={`shrink-0 text-xs tabular-nums ${MUTED}`}>
                  {clock(e.at)}
                </span>
                <p
                  className={`min-w-0 whitespace-pre-wrap break-words ${
                    quiet ? `italic ${MUTED}` : ""
                  }`}
                >
                  {e.to && e.kind === "talk" ? (
                    <span className={`not-italic ${MUTED}`}>
                      <Words
                        text={t["play.private_to"]}
                        slots={{ names: e.to.map(name).join(", ") }}
                      />{" "}
                    </span>
                  ) : null}
                  {by && e.kind === "talk" ? (
                    <span className="font-medium not-italic">{by}: </span>
                  ) : null}
                  {why === "stopped"
                    ? t["play.withheld"]
                    : why === "new"
                      ? t["play.new_held"]
                      : e.text}
                </p>
              </li>
            );
          })}
        </ol>
      </Section>

      {outcome ? (
        <Section title={t["play.outcome"]}>
          <p className="whitespace-pre-wrap break-words">{outcome.summary}</p>
          {outcome.measures.length > 0 ? (
            <dl className="grid gap-3 sm:grid-cols-3">
              {outcome.measures.map((m) => (
                <div key={m.label}>
                  <dt className={`text-sm ${MUTED}`}>{m.label}</dt>
                  <dd className="text-2xl font-semibold">
                    {shown(m.value, m.format)}
                  </dd>
                  {m.note ? (
                    <dd className={`text-xs ${MUTED}`}>{m.note}</dd>
                  ) : null}
                </div>
              ))}
            </dl>
          ) : null}
          {outcome.scores ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className={MUTED}>
                    <th className="py-1 pr-4 font-medium" />
                    {outcome.scores.columns.map((c) => (
                      <th key={c.key} className="py-1 pr-4 font-medium">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {outcome.scores.rows.map((r) => (
                    <tr
                      key={r.participant}
                      className="border-t border-neutral-200 dark:border-neutral-800"
                    >
                      <td className="py-1 pr-4 font-medium">
                        {name(r.participant)}
                      </td>
                      {outcome.scores?.columns.map((c) => (
                        <td key={c.key} className="py-1 pr-4 tabular-nums">
                          {shown(
                            Object.hasOwn(r.values, c.key)
                              ? r.values[c.key]
                              : null,
                            c.format,
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Section>
      ) : null}

      {outcome && outcome.reveals.length > 0 ? (
        <Section title={t["play.reveals"]}>
          <div className="space-y-3">
            {outcome.reveals.map((r) => (
              <div key={`${r.participant}-${r.title}`}>
                <h3 className="font-medium">{r.title}</h3>
                <p className={`whitespace-pre-wrap break-words ${MUTED}`}>
                  {r.text}
                </p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </article>
  );
}
