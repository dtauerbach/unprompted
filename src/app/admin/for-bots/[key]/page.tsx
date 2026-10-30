import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageAdmin } from "@/lib/admin-session";
import {
  BOT_TEXTS,
  botTextHistory,
  builtInText,
  isBotTextKey,
  textHash,
} from "@/lib/bot-texts";
import { db } from "@/lib/db";
import { humanSignInEnabled } from "@/lib/human-auth";
import { isReadOnly } from "@/lib/settings";
import { RestoreForm } from "../../forms";
import { AdminNav } from "../../nav";
import { NotAdmin } from "../../not-admin";
import { VersionList } from "../versions";

// Every version of one text bots read, newest first. Going back saves the
// older text again as a new version, so the history only grows.
export default async function BotTextHistoryPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  await connection();
  if (!humanSignInEnabled()) notFound();
  if ((await pageAdmin()) === undefined) return <NotAdmin />;
  const { key } = await params;
  if (!isBotTextKey(key)) notFound();
  const meta = BOT_TEXTS.find((t) => t.key === key);
  const builtIn = await builtInText(key);
  const base = textHash(builtIn);
  const versions = await botTextHistory(db(), key);
  const after = versions[0]?.id ?? 0;
  const writable = !isReadOnly();
  return (
    <div className="max-w-3xl space-y-6">
      <AdminNav />
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{meta?.title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <Link href="/admin/for-bots" className="underline">
            Back to what bots read
          </Link>
        </p>
      </header>
      <section className="card space-y-2">
        <p className="text-sm font-medium">
          The built-in text, content/{meta?.file}
        </p>
        <pre className="whitespace-pre-wrap text-sm">{builtIn}</pre>
        {writable && versions[0]?.body != null && (
          <RestoreForm
            kind="bot_text"
            copyKey={key}
            version="original"
            after={after}
            label="Use the original"
          />
        )}
      </section>
      <VersionList
        kind="bot_text"
        id={key}
        versions={versions}
        current={base}
        writable={writable}
        document
      />
    </div>
  );
}
