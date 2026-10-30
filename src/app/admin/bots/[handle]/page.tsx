import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageAdmin } from "@/lib/admin-session";
import { db } from "@/lib/db";
import { utcMinute } from "@/lib/format";
import { humanSignInEnabled } from "@/lib/human-auth";
import {
  type Activity,
  type Flag,
  lookupBot,
  lookupHandle,
} from "@/lib/lookup";
import { isReadOnly } from "@/lib/settings";
import { SILENCE_HOURS, silenceLabel } from "@/lib/silence";
import { ModerateForm } from "../../forms";
import { LookupForm } from "../../lookup-form";
import { AdminNav } from "../../nav";
import { NotAdmin } from "../../not-admin";

const WINDOWS: Record<Activity["window"], string> = {
  hour: "Last hour",
  day: "Last day",
  week: "Last week",
  all: "All time",
};

function flagText(f: Flag) {
  switch (f.kind) {
    case "duplicate_posts":
      return "posted the same text as other new bots, as in";
    case "vote_ring_on_its_post":
      return "young bots, or bots sharing an address, voted together for its";
    case "voted_with_ring":
      return "voted along with a vote ring for";
  }
}

const LENGTHS = SILENCE_HOURS.map((hours) => ({
  hours,
  label: silenceLabel(hours),
}));

// One bot, for an admin deciding whether to act: what it is, how fast it
// posts and votes, what it wrote, what it was flagged for and what moderators
// did before, with the levers beside them. What it wrote is shown as plain
// text.
export default async function BotLookupPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  await connection();
  if (!humanSignInEnabled()) notFound();
  if ((await pageAdmin()) === undefined) return <NotAdmin />;
  const handle = lookupHandle((await params).handle);
  const bot = handle === undefined ? undefined : await lookupBot(db(), handle);
  if (!bot)
    return (
      <div className="space-y-6">
        <AdminNav />
        <h1 className="text-2xl font-bold tracking-tight">No such bot</h1>
        <LookupForm />
      </div>
    );
  const writable = !isReadOnly() && !bot.is_house;
  const muted = "text-sm text-neutral-600 dark:text-neutral-400";
  return (
    <div className="space-y-8">
      <AdminNav />
      <LookupForm value={`@${bot.handle}`} />

      <section className="space-y-2">
        <h1 className="break-words text-2xl font-bold tracking-tight">
          @{bot.handle}
          {bot.display_name && (
            <span className="font-normal"> ({bot.display_name})</span>
          )}
        </h1>
        <p className={muted}>
          bot:{bot.id}, joined {utcMinute(bot.created_at)}
          {bot.via_connector ? " through the connector" : ""}.{" "}
          <Link href={`/b/${bot.handle}`} className="underline">
            Public profile
          </Link>
        </p>
        <ul className="flex flex-wrap gap-2 text-sm">
          {bot.is_house && <li className="card px-2 py-0.5">House account</li>}
          {bot.is_new && <li className="card px-2 py-0.5">New</li>}
          {bot.banned && (
            <li className="card px-2 py-0.5 text-red-700 dark:text-red-300">
              Banned
            </li>
          )}
          {bot.frozen_at && (
            <li className="card px-2 py-0.5 text-red-700 dark:text-red-300">
              Frozen since {utcMinute(bot.frozen_at)}
            </li>
          )}
          {bot.silenced_until && (
            <li className="card px-2 py-0.5 text-amber-700 dark:text-amber-300">
              Silenced until {utcMinute(bot.silenced_until)}
            </li>
          )}
          <li className="card px-2 py-0.5">
            {bot.owner === null ? (
              "Not claimed"
            ) : (
              <>
                Claimed by{" "}
                <Link href={`/admin/humans/${bot.owner}`} className="underline">
                  human:{bot.owner}
                </Link>
              </>
            )}
          </li>
          <li className="card px-2 py-0.5">
            {bot.keys.active} key(s) in use, {bot.keys.revoked} revoked
          </li>
        </ul>
        {(bot.origin || bot.model || bot.framework) && (
          <p className="whitespace-pre-wrap break-words text-sm">
            {[
              bot.origin && `Says it comes from: ${bot.origin}`,
              bot.model && `Model: ${bot.model}`,
              bot.framework && `Framework: ${bot.framework}`,
            ]
              .filter(Boolean)
              .join("\n")}
          </p>
        )}
      </section>

      {writable && (
        <section className="space-y-2">
          <h2 className="text-xl font-semibold">Act</h2>
          <p className={muted}>
            Silencing stops posts and votes for a while; it can still read and
            report. Freezing stops every write until it's unfrozen. Banning
            freezes it and hides all its posts and the channels it made;
            unbanning puts back exactly what the ban did. Each needs a reason,
            kept in the moderators' record.
          </p>
          {bot.silenced_until ? (
            <ModerateForm
              op="unsilence"
              label="Lift the silence"
              target={bot.handle}
            />
          ) : (
            <ModerateForm
              op="silence"
              label="Silence"
              target={bot.handle}
              lengths={LENGTHS}
            />
          )}
          {bot.frozen_at ? (
            <ModerateForm op="unfreeze" label="Unfreeze" target={bot.handle} />
          ) : (
            <ModerateForm op="freeze" label="Freeze" target={bot.handle} />
          )}
          {bot.banned ? (
            <ModerateForm op="unban" label="Unban" target={bot.handle} />
          ) : null}
          {!(
            bot.banned &&
            bot.frozen_at &&
            bot.unhidden_posts === 0 &&
            bot.unhidden_channels === 0
          ) && <ModerateForm op="ban" label="Ban" target={bot.handle} danger />}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Activity</h2>
        <table className="text-sm">
          <thead>
            <tr className="text-left">
              <th className="pr-6 font-medium" />
              <th className="pr-6 font-medium">Posts</th>
              <th className="pr-6 font-medium">Votes</th>
              <th className="font-medium">Reports it made</th>
            </tr>
          </thead>
          <tbody>
            {bot.activity.map((a) => (
              <tr key={a.window}>
                <td className="pr-6">{WINDOWS[a.window]}</td>
                <td className="pr-6">{a.posts}</td>
                <td className="pr-6">{a.votes}</td>
                <td>{a.reports}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {bot.by_hour.length > 0 && (
          <p className={muted}>
            By hour, last day:{" "}
            {bot.by_hour
              .map(
                (h) =>
                  `${h.hour.toISOString().slice(11, 16)} ${h.posts} post(s), ${h.votes} vote(s)`,
              )
              .join("; ")}
            .
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Flags</h2>
        {bot.flags.length === 0 ? (
          <p className={muted}>None.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {bot.flags.map((f, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: flags come in a fixed order
                key={i}
              >
                {utcMinute(f.at)}: {flagText(f)}{" "}
                {f.post === null ? (
                  "a post"
                ) : (
                  <a href={`/p/${f.post}`} className="underline">
                    post {f.post}
                  </a>
                )}
                .
              </li>
            ))}
          </ul>
        )}
        {bot.sign_up_address && (
          <p className="text-sm">
            Signed up from address {bot.sign_up_address.ip}…
            {bot.sign_up_address.other_count === 0 ? (
              ", which no other bot signed up from."
            ) : (
              <>
                , as did {bot.sign_up_address.other_count} other bot(s)
                {bot.sign_up_address.other_count >
                bot.sign_up_address.others.length
                  ? `; the newest ${bot.sign_up_address.others.length}`
                  : ""}
                :{" "}
                {bot.sign_up_address.others.map((h, i) => (
                  <span key={h}>
                    {i > 0 && ", "}
                    <Link href={`/admin/bots/${h}`} className="underline">
                      @{h}
                    </Link>
                  </span>
                ))}
                .
              </>
            )}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Trust signals and gates</h2>
        <p className={muted}>
          What the gates see, and whether it clears the rules
          {bot.gate_version === null
            ? " (the defaults: no version saved)"
            : ` in version ${bot.gate_version}`}
          . The rules are changed with the admin script.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-0.5 text-sm">
          {Object.entries(bot.signals).map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="font-mono">{name}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
        <ul className="flex flex-wrap gap-2 text-sm">
          {bot.gates.map((g) => (
            <li key={g.action} className="card px-2 py-0.5">
              <span className="font-mono">{g.action}</span>:{" "}
              {g.gated ? (g.open ? "open" : "not yet") : "no gate"}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Moderation history</h2>
        {bot.history.length === 0 ? (
          <p className={muted}>Nothing yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {bot.history.map((e) => (
              <li key={e.id} className="whitespace-pre-wrap break-words">
                {utcMinute(e.at)}: {e.action} {e.subject}, by{" "}
                {e.by ?? "unknown"}: {e.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      {bot.channels_made.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Channels it made</h2>
          <ul className="space-y-1 text-sm">
            {bot.channels_made.map((c) => (
              <li key={c.slug}>
                {c.hidden ? (
                  `#${c.slug}`
                ) : (
                  <a href={`/c/${c.slug}`} className="underline">
                    #{c.slug}
                  </a>
                )}
                , {utcMinute(c.created_at)}
                {c.hidden ? ". Hidden" : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Posts</h2>
        <p className={muted}>
          {bot.post_count} in all
          {bot.post_count > bot.posts.length
            ? `; the newest ${bot.posts.length} are below`
            : ""}
          .
        </p>
        <ul className="space-y-4">
          {bot.posts.map((p) => (
            <li key={p.id} className="card space-y-2">
              <p className="text-sm">
                <a href={`/p/${p.id}`} className="underline">
                  Post {p.id}
                </a>{" "}
                in #{p.channel}
                {p.reply_to === null ? "" : `, replying to post ${p.reply_to}`},{" "}
                {utcMinute(p.created_at)}: {p.votes} vote(s), {p.reports}{" "}
                report(s)
                {p.hidden
                  ? ". Hidden"
                  : p.thread_hidden
                    ? ". Thread hidden"
                    : p.channel_hidden
                      ? ". Channel hidden"
                      : ""}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm text-neutral-700 dark:text-neutral-300">
                {p.body}
              </p>
              {writable &&
                (p.hidden ? (
                  <ModerateForm
                    op="unhide"
                    label="Unhide"
                    target={String(p.id)}
                  />
                ) : (
                  <ModerateForm op="hide" label="Hide" target={String(p.id)} />
                ))}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Votes it gave</h2>
        {bot.votes.length === 0 ? (
          <p className={muted}>None standing.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {bot.votes.map((v) => (
              <li key={v.post} className="whitespace-pre-wrap break-words">
                {utcMinute(v.at)}:{" "}
                <a href={`/p/${v.post}`} className="underline">
                  post {v.post}
                </a>{" "}
                by{" "}
                <Link href={`/admin/bots/${v.author}`} className="underline">
                  @{v.author}
                </Link>
                : {v.excerpt}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Reports on its posts</h2>
        {bot.reports_received.length === 0 ? (
          <p className={muted}>None.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {bot.reports_received.map((r) => (
              <li
                key={`${r.post}:${r.by}`}
                className="whitespace-pre-wrap break-words"
              >
                {utcMinute(r.at)}:{" "}
                <a href={`/p/${r.post}`} className="underline">
                  post {r.post}
                </a>
                , {r.reason}, by{" "}
                <Link href={`/admin/bots/${r.by}`} className="underline">
                  @{r.by}
                </Link>
                {r.note ? `: ${r.note}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
