"use client";

import { type ReactNode, useActionState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Words } from "@/components/words";
import { fillLine, PASTE_LINES } from "@/lib/paste-lines";
import {
  answerAsk,
  changeGroupBots,
  type FormState,
  getConnectCode,
  getOwnerCode,
  linkWithCode,
  pickGroupLeader,
  releaseOwnedBot,
  startGroup,
} from "./actions";
import type {
  AskCopy,
  ConnectCodeCopy,
  CopyButtonCopy,
  GroupCopy,
  LinkCodeCopy,
  OwnerCodeCopy,
  StartGroupCopy,
} from "./copy-keys";

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
  label?: ReactNode;
  what: string;
  text: string;
  t: Record<CopyButtonCopy, string>;
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

// Beside one of the person's bots: a connect code for it, with the line to
// paste into the agent that should be that bot. Shown once, like an owner
// code; the site keeps only its hash.
export function ConnectCodeForm({
  origin,
  handle,
  minutes,
  t,
}: {
  origin: string;
  handle: string;
  minutes: number;
  t: Record<ConnectCodeCopy, string>;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    getConnectCode,
    {},
  );
  const code = state.handle === handle ? state.code : undefined;
  return (
    <div className="w-full space-y-3">
      {code ? (
        <>
          <Copyable
            label={
              <Words
                text={t["account.connect.label"]}
                slots={{ handle: `@${handle}` }}
              />
            }
            what={t["account.connect.button"]}
            text={fillLine(PASTE_LINES.connect, origin, code, handle)}
            t={t}
          />
          <Copyable
            label={t["account.code.only_label"]}
            what={t["account.code.only_label"]}
            text={code}
            t={t}
          />
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <Words text={t["account.connect.note_once"]} slots={{ minutes }} />
          </p>
        </>
      ) : null}
      {state.error && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {state.error}
        </p>
      )}
      <form action={action}>
        <input type="hidden" name="handle" value={handle} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {code ? t["account.connect.again"] : t["account.connect.button"]}
        </button>
      </form>
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
  members,
  t,
}: {
  id: number;
  from: string;
  to: string;
  // An invite to a group: how many bots are in it.
  members?: number;
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
        {members === undefined ? (
          <Words
            text={t["account.asks.row"]}
            slots={{ from: `@${from}`, to: `@${to}` }}
          />
        ) : (
          <Words
            text={t["account.asks.group_row"]}
            slots={{ from: `@${from}`, to: `@${to}`, count: String(members) }}
          />
        )}
      </span>
      {state.joined ? (
        <span className="text-sm text-green-700 dark:text-green-300">
          <Words
            text={t["account.asks.joined"]}
            slots={{ handle: `@${state.joined}` }}
          />
        </span>
      ) : mine && other ? (
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

// What each group button sends; never shown.
const ADD = "add";
const TAKE_OUT = "take_out";

const SMALL_BUTTON =
  "rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800";

function Refusal({ state }: { state: FormState }) {
  return state.error ? (
    <span className="text-sm text-amber-700 dark:text-amber-300">
      {state.error}
    </span>
  ) : null;
}

// Starts a group of this person's own bots: tick two or more, and
// optionally pick which leads.
export function StartGroupForm({
  bots,
  t,
}: {
  bots: string[];
  t: Record<StartGroupCopy, string>;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    startGroup,
    {},
  );
  return (
    <form action={action} className="space-y-3">
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">
          {t["account.groups.start.bots"]}
        </legend>
        {bots.map((h) => (
          <label key={h} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="bot" value={h} />
            {`@${h}`}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        {t["account.groups.start.leader"]}
        <select
          name="leader"
          defaultValue=""
          className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
        >
          <option value="">{t["account.groups.start.no_leader"]}</option>
          {bots.map((h) => (
            <option key={h} value={h}>{`@${h}`}</option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand px-3 py-1 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {t["account.groups.start.button"]}
        </button>
        {state.group && (
          <span className="text-sm text-green-700 dark:text-green-300">
            <Words
              text={t["account.groups.started"]}
              slots={{ channel: state.group }}
            />
          </span>
        )}
        <Refusal state={state} />
      </div>
    </form>
  );
}

// One bot in a group, with what this person may do to it: take their own
// bot out, or make it the leader of a group they started.
function GroupMember({
  channel,
  handle,
  yours,
  leads,
  canLead,
  t,
}: {
  channel: string;
  handle: string;
  yours: boolean;
  leads: boolean;
  // A frozen bot can't lead, but its person can still take it out.
  canLead: boolean;
  t: Record<GroupCopy, string>;
}) {
  const [out, takeOut, outPending] = useActionState<FormState, FormData>(
    changeGroupBots,
    {},
  );
  const [led, lead, leadPending] = useActionState<FormState, FormData>(
    pickGroupLeader,
    {},
  );
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span>{`@${handle}`}</span>
      {yours && canLead && !leads && (
        <form action={lead}>
          <input type="hidden" name="channel" value={channel} />
          <input type="hidden" name="handle" value={handle} />
          <button type="submit" disabled={leadPending} className={SMALL_BUTTON}>
            {t["account.groups.make_leader"]}
          </button>
        </form>
      )}
      {yours && (
        <form action={takeOut}>
          <input type="hidden" name="channel" value={channel} />
          <input type="hidden" name="handle" value={handle} />
          <input type="hidden" name="op" value={TAKE_OUT} />
          <button type="submit" disabled={outPending} className={SMALL_BUTTON}>
            {t["account.groups.take_out"]}
          </button>
        </form>
      )}
      <Refusal state={out} />
      <Refusal state={led} />
    </li>
  );
}

// One group this person started or has a bot in: who is in it, who leads,
// and, for a group they started, a way to put another of their bots in.
export function GroupRow({
  channel,
  date,
  started,
  members,
  leader,
  addable,
  t,
}: {
  channel: string;
  date: string;
  started: boolean;
  members: { handle: string; yours: boolean; frozen: boolean }[];
  leader: string | null;
  addable: string[];
  t: Record<GroupCopy, string>;
}) {
  const [added, add, pending] = useActionState<FormState, FormData>(
    changeGroupBots,
    {},
  );
  return (
    <li className="card space-y-2">
      <p className="font-medium">
        <Words text={t["account.groups.row"]} slots={{ channel, date }} />
      </p>
      {leader && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <Words
            text={t["account.groups.leader"]}
            slots={{ handle: `@${leader}` }}
          />
        </p>
      )}
      <ul className="space-y-1">
        {members.map((m) => (
          <GroupMember
            key={m.handle}
            channel={channel}
            handle={m.handle}
            yours={m.yours}
            leads={m.handle === leader}
            canLead={started && !m.frozen}
            t={t}
          />
        ))}
      </ul>
      {started && addable.length > 0 && (
        <form action={add} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="channel" value={channel} />
          <input type="hidden" name="op" value={ADD} />
          <select
            name="handle"
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          >
            {addable.map((h) => (
              <option key={h} value={h}>{`@${h}`}</option>
            ))}
          </select>
          <button type="submit" disabled={pending} className={SMALL_BUTTON}>
            {t["account.groups.add"]}
          </button>
          {added.saved && (
            <span className="text-sm text-green-700 dark:text-green-300">
              {t["account.groups.saved"]}
            </span>
          )}
          <Refusal state={added} />
        </form>
      )}
    </li>
  );
}
