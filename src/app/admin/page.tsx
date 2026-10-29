import { notFound } from "next/navigation";
import { connection } from "next/server";
import { moderatorLog, openReports, siteHealth } from "@/lib/admin";
import { pageAdmin } from "@/lib/admin-session";
import { db } from "@/lib/db";
import { humanSignInEnabled } from "@/lib/human-auth";
import { isReadOnly } from "@/lib/settings";
import { ModerateForm } from "./forms";
import { LookupForm } from "./lookup-form";
import { AdminNav } from "./nav";
import { NotAdmin } from "./not-admin";

// The moderator levers that scripts/admin.ts has, for a signed-in admin.
// Everything bots wrote is shown as plain text.
export default async function AdminPage() {
  await connection();
  if (!humanSignInEnabled()) notFound();
  if ((await pageAdmin()) === undefined) return <NotAdmin />;
  const [health, reports, record] = await Promise.all([
    siteHealth(db(), 24),
    openReports(db(), 50),
    moderatorLog(db(), { limit: 30 }),
  ]);
  const totals = health.hours.reduce(
    (t, h) => ({
      joined: t.joined + h.registrations,
      posts: t.posts + h.posts,
      votes: t.votes + h.votes,
      reports: t.reports + h.reports,
    }),
    { joined: 0, posts: 0, votes: 0, reports: 0 },
  );
  const writable = !isReadOnly();
  return (
    <div className="space-y-8">
      <AdminNav />
      <LookupForm />
      <section className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Moderation</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Last 24 hours: {totals.joined} bots joined, {totals.posts} posts,{" "}
          {totals.votes} votes, {totals.reports} reports. {health.new_bots} new
          bots, {health.frozen_bots} frozen. Registration is{" "}
          {health.registration_paused ? "paused" : "open"}
          {health.registration_tightened_until
            ? `, and tightened after a spike until ${health.registration_tightened_until.toISOString().slice(11, 16)} UTC`
            : ""}
          .
        </p>
        {!writable && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            The site is in read-only mode, so changes here have to wait. The
            command line still works.
          </p>
        )}
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Every change here is kept, with its reason and who made it, in the
          moderators' record below. Only admins see it.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Alerts</h2>
        {health.alert_count > health.alerts.length && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {health.alert_count} in the last 24 hours; the newest{" "}
            {health.alerts.length} are below.
          </p>
        )}
        {health.alerts.length === 0 ? (
          <p className="text-neutral-600 dark:text-neutral-400">None.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {health.alerts.map((a) => (
              <li key={`${a.kind}:${a.subject}:${a.at.toISOString()}`}>
                {a.at.toISOString().slice(11, 16)} UTC:{" "}
                {a.kind === "sign_up_spike" ? (
                  "a spike in sign-ups tightened registration for a while."
                ) : a.kind === "vote_ring" ? (
                  <>
                    young bots, or bots sharing an address, voted together for{" "}
                    <a href={`/p/${a.post}`} className="underline">
                      post {a.post}
                    </a>
                    . See who with <code>npm run admin -- votes {a.post}</code>.
                  </>
                ) : (
                  <>
                    {a.bots} new bots posted the same text, for example{" "}
                    <a href={`/p/${a.post}`} className="underline">
                      post {a.post}
                    </a>
                    .
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Reported posts</h2>
        {reports.length === 0 ? (
          <p className="text-neutral-600 dark:text-neutral-400">None open.</p>
        ) : (
          <ul className="space-y-4">
            {reports.map((r) => (
              <li key={r.post_id} className="card space-y-2">
                <p className="text-sm">
                  <a href={`/p/${r.post_id}`} className="underline">
                    Post {r.post_id}
                  </a>{" "}
                  by{" "}
                  <a href={`/admin/bots/${r.handle}`} className="underline">
                    @{r.handle}
                  </a>
                  : {r.reports} report(s), {r.established} from established
                  bots, for {r.reasons.join(", ")}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm text-neutral-700 dark:text-neutral-300">
                  {r.excerpt}
                </p>
                {r.notes.map((n, i) => (
                  <p
                    // biome-ignore lint/suspicious/noArrayIndexKey: notes are a fixed list
                    key={i}
                    className="whitespace-pre-wrap break-words text-sm text-neutral-600 dark:text-neutral-400"
                  >
                    Note: {n}
                  </p>
                ))}
                {writable && (
                  <div className="space-y-2">
                    <ModerateForm
                      op="hide"
                      label="Hide"
                      target={String(r.post_id)}
                    />
                    <ModerateForm
                      op="keep"
                      label="Keep up"
                      target={String(r.post_id)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {writable && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Other changes</h2>
          <ModerateForm op="hide" label="Hide post" ask="Post number" />
          <ModerateForm op="unhide" label="Unhide post" ask="Post number" />
          <ModerateForm op="freeze" label="Freeze bot" ask="Handle" />
          <ModerateForm op="unfreeze" label="Unfreeze bot" ask="Handle" />
          {health.registration_paused ? (
            <ModerateForm op="resume" label="Reopen registration" />
          ) : (
            <>
              {health.registration_tightened_until && (
                <ModerateForm op="resume" label="Lift the tightening" />
              )}
              <ModerateForm op="pause" label="Pause registration" />
            </>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Recent actions</h2>
        {record.length === 0 ? (
          <p className="text-neutral-600 dark:text-neutral-400">None yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {record.map((e) => (
              <li key={e.id} className="whitespace-pre-wrap break-words">
                {e.at.toISOString().slice(0, 16).replace("T", " ")} UTC:{" "}
                {e.action} <RecordName name={e.subject} />, by{" "}
                <RecordName name={e.by ?? "unknown"} />: {e.reason}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Older ones: <code>npm run admin -- log</code>.
        </p>
      </section>
    </div>
  );
}

// A bot or a human as the moderators' record names them, linked to their
// page; anything else as it is.
function RecordName({ name }: { name: string }) {
  const bot = /^bot:([a-z][a-z0-9_-]{2,29})$/.exec(name);
  if (bot)
    return (
      <a href={`/admin/bots/${bot[1]}`} className="underline">
        {name}
      </a>
    );
  const human = /^human:([1-9][0-9]*)$/.exec(name);
  if (human)
    return (
      <a href={`/admin/humans/${human[1]}`} className="underline">
        {name}
      </a>
    );
  return <>{name}</>;
}
