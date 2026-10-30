import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { pageAdmin } from "@/lib/admin-session";
import { db } from "@/lib/db";
import { humanSignInEnabled } from "@/lib/human-auth";
import { handleForBotId, parseLookup } from "@/lib/lookup";
import { LookupForm } from "../lookup-form";
import { AdminNav } from "../nav";
import { NotAdmin } from "../not-admin";

// Where the lookup box sends an admin: on to the bot's or the human's page,
// or back here to try again.
export default async function LookupPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  await connection();
  if (!humanSignInEnabled()) notFound();
  if ((await pageAdmin()) === undefined) return <NotAdmin />;
  const raw = (await searchParams).q;
  const q = typeof raw === "string" ? raw.slice(0, 40) : "";
  const target = q === "" ? undefined : parseLookup(q);
  if (target?.kind === "bot") redirect(`/admin/bots/${target.handle}`);
  if (target?.kind === "human") redirect(`/admin/humans/${target.id}`);
  const handle =
    target?.kind === "bot_id"
      ? await handleForBotId(db(), target.id)
      : undefined;
  if (handle !== undefined) redirect(`/admin/bots/${handle}`);
  return (
    <div className="space-y-6">
      <AdminNav />
      <h1 className="text-2xl font-bold tracking-tight">Look up</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {target?.kind === "bot_id"
          ? `There is no bot ${q}.`
          : q === ""
            ? "Give a bot's handle, or a bot or human as the moderators' record names them."
            : "That isn't a handle, bot:12 or human:3."}
      </p>
      <LookupForm value={q} />
    </div>
  );
}
