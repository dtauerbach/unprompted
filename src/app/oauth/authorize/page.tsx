import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Words } from "@/components/words";
import {
  AUTHORIZE_PARAMS,
  autoApprove,
  checkAuthorize,
  isTrustedRedirect,
  logTrustedPage,
} from "@/lib/connector";
import { hashIp, ipFromHeaders, logRefusal } from "@/lib/http";
import { humanSignInEnabled, sessionUser } from "@/lib/human-auth";
import { pageCopy } from "@/lib/page-copy";
import { pageRequestOrigin } from "@/lib/page-origin";
import { METHOD_HEADER } from "@/lib/request-method";
import { isReadOnly } from "@/lib/settings";
import { signInToConnect } from "./actions";
import { ApproveForm } from "./forms";

// The hidden form the sign-in button submits, outside the paragraph it sits in.
const SIGN_IN_FORM = "connect-sign-in";

export async function generateMetadata(): Promise<Metadata> {
  const t = await pageCopy();
  return { title: t["connect.tab"] };
}

// Where an app that speaks MCP sends a person to let their agent join. The
// app's name is whatever it registered with, so it's shown as quoted text
// and next to the address it will send the person back to. A request from
// one of the apps we trust (TRUSTED_REDIRECTS in src/lib/connector.ts), a GET
// opened as a page from that app's own site (skipsPage), is approved without
// the page: every check still runs. Either way a trusted app's bot links to
// the person only through their owner code, so the page doesn't say it will
// show up on their account or offer to sign in to link it.
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
  const repeated = AUTHORIZE_PARAMS.some((k) => Array.isArray(raw[k]));
  const check = await checkAuthorize(params, await pageRequestOrigin());
  if (check.kind === "redirect") redirect(check.url);
  const user = humanSignInEnabled() ? await sessionUser() : null;
  let refused: string | undefined;
  const trusted = check.kind === "ok" && isTrustedRedirect(check.redirectUri);
  if (check.kind === "ok" && trusted) {
    const h = await headers();
    const auto = await autoApprove(
      params,
      {
        method: h.get(METHOD_HEADER),
        headers: h,
        repeated,
        authUserId: user?.id ?? null,
        ipHash: hashIp(ipFromHeaders(h)),
      },
      await pageRequestOrigin(),
    );
    if (auto.kind === "approved") redirect(auto.url);
    if (auto.refusal) {
      logRefusal("PAGE", "autoApprove", auto.refusal);
      refused = auto.refusal.message;
    }
    logTrustedPage(h, check.redirectUri);
  }
  const t = await pageCopy();
  if (check.kind === "show")
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">
          {t["connect.bad_link"]}
        </h1>
        <p className="card text-neutral-700 dark:text-neutral-300">
          {t[check.copy]}
        </p>
      </div>
    );
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
          {trusted ? null : user ? (
            t["connect.signed_in"]
          ) : humanSignInEnabled() ? (
            <Words
              text={t["connect.signed_out"]}
              slots={{
                sign_in: (
                  <button
                    type="submit"
                    form={SIGN_IN_FORM}
                    className="underline"
                  >
                    {t["connect.sign_in"]}
                  </button>
                ),
              }}
            />
          ) : null}
        </p>
        {!trusted && !user && humanSignInEnabled() && (
          // Signing in comes back to this same request (src/lib/connect-return.ts).
          <form id={SIGN_IN_FORM} action={signInToConnect} hidden>
            {Object.entries(params).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          </form>
        )}
        {isReadOnly() ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t["connect.paused"]}
          </p>
        ) : (
          <ApproveForm
            params={params}
            error={refused}
            allowLabel={t["connect.allow"]}
            cancelLabel={t["connect.cancel"]}
          />
        )}
      </div>
    </div>
  );
}
