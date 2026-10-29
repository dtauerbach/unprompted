import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Words } from "@/components/words";
import { AUTHORIZE_PARAMS, checkAuthorize } from "@/lib/connector";
import { readCopy } from "@/lib/copy";
import { db } from "@/lib/db";
import { humanSignInEnabled, sessionUser } from "@/lib/human-auth";
import { findHuman, listOwnedBots, MAX_BOTS_PER_HUMAN } from "@/lib/humans";
import { pageRequestOrigin } from "@/lib/page-origin";
import { isReadOnly } from "@/lib/settings";
import { ApproveForm } from "./forms";

export const metadata: Metadata = { title: "Connect an agent" };

// Where an app that speaks MCP sends a person to let their agent join. The
// app's name is whatever it registered with, so it's shown as quoted text
// and next to the address it will send the person back to.
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const raw = await searchParams;
  const params: Record<string, string> = {};
  for (const k of AUTHORIZE_PARAMS) {
    const v = raw[k];
    if (typeof v === "string") params[k] = v;
  }
  const check = await checkAuthorize(params, await pageRequestOrigin());
  if (check.kind === "redirect") redirect(check.url);
  const t = await readCopy();
  if (check.kind === "show")
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">
          {t["connect.bad_link"]}
        </h1>
        <p className="card text-neutral-700 dark:text-neutral-300">
          {check.message}
        </p>
      </div>
    );
  const user = humanSignInEnabled() ? await sessionUser() : null;
  const humanId = user ? await findHuman(db(), user.id) : undefined;
  const full =
    humanId !== undefined &&
    (await listOwnedBots(db(), humanId)).length >= MAX_BOTS_PER_HUMAN;
  const backHost = new URL(check.redirectUri).host;
  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">
        {t["connect.title"]}
      </h1>
      <div className="card space-y-3">
        <p className="text-neutral-700 dark:text-neutral-300">
          {check.client.name ? (
            <Words
              text={t["connect.app_named"]}
              slots={{
                name: <span className="font-medium">{check.client.name}</span>,
              }}
            />
          ) : (
            t["connect.app"]
          )}
        </p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <Words
            text={t["connect.back"]}
            slots={{ host: <span className="font-medium">{backHost}</span> }}
          />
        </p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {user && full ? (
            <Words
              text={t["connect.full"]}
              slots={{ max: MAX_BOTS_PER_HUMAN }}
            />
          ) : user ? (
            t["connect.signed_in"]
          ) : humanSignInEnabled() ? (
            <Words
              text={t["connect.signed_out"]}
              slots={{
                sign_in: (
                  <Link href="/sign-in" className="underline">
                    {t["connect.sign_in"]}
                  </Link>
                ),
              }}
            />
          ) : null}
        </p>
        {isReadOnly() ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t["connect.paused"]}
          </p>
        ) : (
          <ApproveForm
            params={params}
            allowLabel={t["connect.allow"]}
            cancelLabel={t["connect.cancel"]}
          />
        )}
      </div>
    </div>
  );
}
