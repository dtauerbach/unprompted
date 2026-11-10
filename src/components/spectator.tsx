import Link from "next/link";
import type { Copy } from "@/lib/copy";
import { type Board, boardOf, type Feed } from "@/lib/spectator";
import { exactUtc } from "@/lib/time";
import { Timestamp } from "./timestamp";
import { Words } from "./words";

// A match as a Table's spectator feed describes it (docs/SPECTATOR.md), drawn
// in the site's own style. Every string in a feed is the Table's or a
// player's, so each is rendered as a React text node: never HTML, never a
// link, never a tab title. The only links are the site's own: a player's
// profile, from a handle the format has already checked.

const MUTED = "text-neutral-600 dark:text-neutral-400";

type Who = Map<string, Feed["participants"][number]>;

export function shown(value: number | null | undefined, format: string) {
  if (value === null || value === undefined) return "–";
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

export function StatusBadge({ status, t }: { status: string; t: Copy }) {
  const live = status === "live";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
        live
          ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100"
          : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
      }`}
    >
      {live ? t["play.live"] : t["play.over"]}
    </span>
  );
}

function Player({ p }: { p: Feed["participants"][number] }) {
  return (
    <li>
      <span className="font-medium">{p.label}</span>
      {p.handle ? (
        <>
          {" "}
          <Link href={`/b/${p.handle}`} className={`${MUTED} underline`}>
            @{p.handle}
          </Link>
        </>
      ) : null}
      {p.note ? <span className={MUTED}> · {p.note}</span> : null}
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

export function MatchView({
  feed,
  table,
  t,
  now = new Date(),
}: {
  feed: Feed;
  table: string;
  t: Copy;
  now?: Date;
}) {
  const who: Who = new Map(feed.participants.map((p) => [p.id, p]));
  const board = boardOf(feed);
  const { match, outcome } = feed;
  return (
    <article className="space-y-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{table}</h1>
          <StatusBadge status={match.status} t={t} />
        </div>
        <p className={`text-sm ${MUTED}`}>
          Started <Timestamp at={new Date(match.started_at)} now={now} />
          {match.phase ? (
            <>
              {" · "}
              {match.phase.label}
              {match.phase.due ? (
                <> until {clock(match.phase.due)} UTC</>
              ) : null}
            </>
          ) : null}
        </p>
        {match.summary ? <p>{match.summary}</p> : null}
        <p className={`text-sm ${MUTED}`}>
          <Words text={t["play.from"]} slots={{ table }} />
          {match.status === "live" ? <> {t["play.updating"]}</> : null}
        </p>
      </header>

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
                        {who.get(r.participant)?.label ?? r.participant}
                      </td>
                      {outcome.scores?.columns.map((c) => (
                        <td key={c.key} className="py-1 pr-4 tabular-nums">
                          {shown(r.values[c.key], c.format)}
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

      {board ? (
        <Section title={board.title}>
          {board.tables.map((tb) => (
            <TablePlan key={tb.label} table={tb} who={who} />
          ))}
        </Section>
      ) : null}

      <Section title={t["play.who"]}>
        <ul className="space-y-1">
          {feed.participants.map((p) => (
            <Player key={p.id} p={p} />
          ))}
        </ul>
      </Section>

      <Section title={t["play.timeline"]}>
        <ol className="space-y-2">
          {feed.timeline.map((e, i) => {
            const by = e.by ? (who.get(e.by)?.label ?? e.by) : null;
            const quiet = e.kind !== "talk";
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
                  {by && e.kind === "talk" ? (
                    <span className="font-medium not-italic">{by}: </span>
                  ) : null}
                  {e.text}
                </p>
              </li>
            );
          })}
        </ol>
      </Section>

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
