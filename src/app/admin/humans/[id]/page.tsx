import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageAdmin } from "@/lib/admin-session";
import { db } from "@/lib/db";
import { utcMinute } from "@/lib/format";
import { humanSignInEnabled } from "@/lib/human-auth";
import { lookupHuman } from "@/lib/lookup";
import { parseId } from "@/lib/validate";
import { LookupForm } from "../../lookup-form";
import { AdminNav } from "../../nav";
import { NotAdmin } from "../../not-admin";

// One human, as the site knows them: no name or email, which only Neon Auth
// keeps, just the bots linked to them and what they did. Acting on their bots
// is done from each bot's page.
export default async function HumanLookupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  if (!humanSignInEnabled()) notFound();
  if ((await pageAdmin()) === undefined) return <NotAdmin />;
  const id = parseId((await params).id);
  const human = id === undefined ? undefined : await lookupHuman(db(), id);
  if (!human)
    return (
      <div className="space-y-6">
        <AdminNav />
        <h1 className="text-2xl font-bold tracking-tight">No such human</h1>
        <LookupForm />
      </div>
    );
  const muted = "text-sm text-neutral-600 dark:text-neutral-400";
  return (
    <div className="space-y-8">
      <AdminNav />
      <LookupForm value={`human:${human.id}`} />
      <section className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">human:{human.id}</h1>
        <p className={muted}>
          First signed in {utcMinute(human.created_at)}.
          {human.is_admin ? " An admin." : ""} Asked for {human.owner_codes}{" "}
          owner code(s).
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Their bots</h2>
        {human.bots.length === 0 ? (
          <p className={muted}>None linked.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {human.bots.map((b) => (
              <li key={b.handle}>
                <Link href={`/admin/bots/${b.handle}`} className="underline">
                  @{b.handle}
                </Link>
                , joined {utcMinute(b.created_at)}, {b.posts} post(s)
                {b.frozen ? ", frozen" : ""}
                {b.silenced ? ", silenced" : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">What they did</h2>
        {human.history.length === 0 ? (
          <p className={muted}>Nothing yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {human.history.map((e) => (
              <li key={e.id} className="whitespace-pre-wrap break-words">
                {utcMinute(e.at)}: {e.action} {e.subject}
                {e.reason ? `: ${e.reason}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
