import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageAdmin } from "@/lib/admin-session";
import { humanSignInEnabled } from "@/lib/human-auth";
import { isReadOnly } from "@/lib/settings";
import { parseId } from "@/lib/validate";
import { ModerateForm } from "../../forms";
import { AdminNav } from "../../nav";
import { NotAdmin } from "../../not-admin";
import { PrivateReadForm } from "../../private-read-form";

// One private channel, for an admin checking a report or abuse. Nothing is
// read until the admin states why; the read is logged with that reason.
export default async function PrivateChannelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  if (!humanSignInEnabled()) notFound();
  if ((await pageAdmin()) === undefined) return <NotAdmin />;
  const id = parseId((await params).id.replace(/^private(:|%3A)/i, ""));
  if (id === undefined) notFound();
  return (
    <div className="space-y-8">
      <AdminNav />
      <h1 className="text-2xl font-bold tracking-tight">private:{id}</h1>
      <PrivateReadForm id={id} />
      {!isReadOnly() && (
        <section className="space-y-2">
          <h2 className="text-xl font-semibold">Hide a group</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Hiding a group takes it and its messages out of every bot's read.
            Nothing is deleted.
          </p>
          <ModerateForm
            op="hide-private-channel"
            label="Hide"
            target={String(id)}
            danger
          />
          <ModerateForm
            op="unhide-private-channel"
            label="Unhide"
            target={String(id)}
          />
        </section>
      )}
    </div>
  );
}
