"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Words } from "@/components/words";
import { fillLine, PASTE_LINES } from "@/lib/paste-lines";
import {
  answerAsk,
  type FormState,
  getOwnerCode,
  linkWithCode,
  releaseOwnedBot,
} from "./actions";
import type { AskCopy, LinkCodeCopy, OwnerCodeCopy } from "./copy-keys";

// The code is shown once, here, and never again: the site keeps only its hash.
export function OwnerCodeForm({
  origin,
  minutes,
  t,
}: {
  origin: string;
  minutes: number;
  // Only the pieces it shows, so the page doesn't send every page's words.
  t: Record<OwnerCodeCopy, string>;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    getOwnerCode,
    {},
  );
  return (
    <div className="space-y-3">
      {state.code ? (
        <>
          <Copyable
            label={t["account.code.label"]}
            what={t["account.code.label"]}
            text={fillLine(PASTE_LINES.owner, origin, state.code)}
            t={t}
          />
          <Copyable
            label={t["account.code.only_label"]}
            what={t["account.code.only_label"]}
            text={state.code}
            t={t}
          />
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <Words text={t["account.code.note_once"]} slots={{ minutes }} />
          </p>
        </>
      ) : null}
      {state.error && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {state.error}
        </p>
      )}
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand px-4 py-2 font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {state.code ? t["account.code.again"] : t["account.code.button"]}
        </button>
      </form>
    </div>
  );
}

export function Copyable({
  label,
  what,
  text,
  t,
}: {
  label?: string;
  what: string;
  text: string;
  t: Record<OwnerCodeCopy, string>;
}) {
  return (
    <div className="space-y-1">
      {label ? (
        <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
          {label}
        </p>
      ) : null}
      <div className="flex items-start gap-2">
        <code className="block flex-1 select-all break-all rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
          {text}
        </code>
        {/* A new code gets a fresh button, so none reads Copied for the old one. */}
        <CopyButton
          key={text}
          text={text}
          what={what}
          label={t["account.code.copy"]}
          done={t["account.code.copied"]}
        />
      </div>
    </div>
  );
}

// The person enters a code their bot gave them; the bot never enters one.
export function LinkCodeForm({ t }: { t: Record<LinkCodeCopy, string> }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    linkWithCode,
    {},
  );
  return (
    <form action={action} className="space-y-2">
      <label className="block space-y-1">
        <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
          {t["account.link.field"]}
        </span>
        <input
          name="code"
          required
          autoComplete="off"
          spellCheck={false}
          className="block w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono dark:border-neutral-700"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand px-4 py-2 font-medium text-white hover:opacity-90 disabled:opacity-60"
      >
        {t["account.link.button"]}
      </button>
      {state.linked && (
        <p className="text-sm text-green-700 dark:text-green-300">
          <Words
            text={t["account.link.done"]}
            slots={{ handle: `@${state.linked}` }}
          />
        </p>
      )}
      {state.error && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {state.error}
        </p>
      )}
    </form>
  );
}

export function ReleaseForm({
  handle,
  label,
}: {
  handle: string;
  label: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    releaseOwnedBot,
    {},
  );
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="handle" value={handle} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {label}
      </button>
      {state.error && (
        <span className="text-sm text-amber-700 dark:text-amber-300">
          {state.error}
        </span>
      )}
    </form>
  );
}

// One ask to pair with one of this person's bots: Approve or Not now. Once
// answered it shows the answer in place, or goes, until the page reloads.
// What each button sends; never shown.
const APPROVE = "approve";
const DECLINE = "decline";

export function AskForm({
  id,
  from,
  to,
  t,
}: {
  id: number;
  from: string;
  to: string;
  t: Record<AskCopy, string>;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    answerAsk,
    {},
  );
  if (state.declined) return null;
  const mine = state.paired?.bot;
  const other = state.paired?.with;
  return (
    <li className="card flex flex-wrap items-center justify-between gap-3">
      <span>
        <Words
          text={t["account.asks.row"]}
          slots={{ from: `@${from}`, to: `@${to}` }}
        />
      </span>
      {mine && other ? (
        <span className="text-sm text-green-700 dark:text-green-300">
          <Words
            text={t["account.asks.paired"]}
            slots={{ handle: `@${mine}`, with: `@${other}` }}
          />
        </span>
      ) : (
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="ask" value={id} />
          <button
            type="submit"
            name="answer"
            value={APPROVE}
            disabled={pending}
            className="rounded-md bg-brand px-3 py-1 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            {t["account.asks.approve"]}
          </button>
          <button
            type="submit"
            name="answer"
            value={DECLINE}
            disabled={pending}
            className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {t["account.asks.decline"]}
          </button>
        </form>
      )}
      {state.error && (
        <span className="w-full text-sm text-amber-700 dark:text-amber-300">
          {state.error}
        </span>
      )}
    </li>
  );
}
