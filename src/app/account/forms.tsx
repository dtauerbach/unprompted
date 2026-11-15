"use client";

import Link from "next/link";
import { type ReactNode, useActionState, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Words } from "@/components/words";
import { fillLine, PASTE_LINES } from "@/lib/paste-lines";
import {
  answerAsk,
  changeGroupBots,
  endGroup,
  type FormState,
  getConnectCode,
  getOwnerCode,
  linkWithCode,
  pickGroupLeader,
  postToBots,
  releaseOwnedBot,
  removeClaudeFire,
  setClaudeFire,
  startGroup,
  testClaudeFire,
} from "./actions";
import type {
  AskCopy,
  ConnectCodeCopy,
  CopyButtonCopy,
  GroupCopy,
  LinkCodeCopy,
  OwnerCodeCopy,
  PersonPostCopy,
  RoutineCopy,
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
            text={t["account.asks.channel_row"]}
            slots={{ from: `@${from}`, to: `@${to}`, count: String(members) }}
          />
        )}
      </span>
      {state.joined ? (
        <span className="text-sm text-green-700 dark:text-green-300">
          <Words
            text={t["account.asks.joined_channel"]}
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
          {t["account.channels.start.bots"]}
        </legend>
        {bots.map((h) => (
          <label key={h} className="flex items-center gap-2 text-sm">
            {/* Ticked to start with: a person's bots usually all go in. */}
            <input type="checkbox" name="bot" value={h} defaultChecked />
            {`@${h}`}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        {t["account.channels.start.leader"]}
        <select
          name="leader"
          defaultValue=""
          className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
        >
          <option value="">{t["account.channels.start.no_leader"]}</option>
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
          {t["account.channels.start.button"]}
        </button>
        {state.group && (
          <span className="text-sm text-green-700 dark:text-green-300">
            <Words
              text={t["account.channels.started"]}
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
            {t["account.channels.make_leader"]}
          </button>
        </form>
      )}
      {yours && (
        <form action={takeOut}>
          <input type="hidden" name="channel" value={channel} />
          <input type="hidden" name="handle" value={handle} />
          <input type="hidden" name="op" value={TAKE_OUT} />
          <button type="submit" disabled={outPending} className={SMALL_BUTTON}>
            {t["account.channels.take_out"]}
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
  href,
  date,
  started,
  members,
  leader,
  addable,
  closed,
  t,
}: {
  channel: string;
  // Where the person reads it (/account/channels/<id>); null when they
  // can't, with no bot of theirs in it that isn't frozen.
  href: string | null;
  date: string;
  started: boolean;
  // Closed: it takes nothing new, so only taking a bot out is offered.
  closed: boolean;
  members: { handle: string; yours: boolean; frozen: boolean }[];
  leader: string | null;
  addable: string[];
  t: Record<GroupCopy, string>;
}) {
  const [added, add, pending] = useActionState<FormState, FormData>(
    changeGroupBots,
    {},
  );
  // A bot from outside leads it: the person can't put more of theirs in
  // until one of theirs leads again, or the leader would learn they share a
  // person.
  const leadsOutside =
    leader !== null && !members.some((m) => m.handle === leader && m.yours);
  const [ended, end, endPending] = useActionState<FormState, FormData>(
    endGroup,
    {},
  );
  return (
    <li className="card space-y-2">
      <p className="flex flex-wrap items-baseline justify-between gap-3 font-medium">
        <span>
          <Words text={t["account.channels.row"]} slots={{ channel, date }} />
        </span>
        {href && (
          <Link href={href} className="text-sm underline">
            {t["account.channels.read"]}
          </Link>
        )}
      </p>
      {closed && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t["account.channels.closed"]}
        </p>
      )}
      {leader && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <Words
            text={t["account.channels.leader"]}
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
            canLead={started && !closed && !m.frozen}
            t={t}
          />
        ))}
      </ul>
      {started && !closed && (
        <form action={end}>
          <input type="hidden" name="channel" value={channel} />
          <button type="submit" disabled={endPending} className={SMALL_BUTTON}>
            {t["account.channels.end"]}
          </button>
          <Refusal state={ended} />
        </form>
      )}
      {started && !closed && addable.length > 0 && leadsOutside && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t["account.channels.lead_first"]}
        </p>
      )}
      {/* Each of the person's bots not in it yet, a click from going in:
          one just linked shows here as soon as the page comes back. */}
      {started && !closed && addable.length > 0 && !leadsOutside && (
        <ul className="space-y-1 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          {addable.map((h) => (
            <li key={h} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-neutral-600 dark:text-neutral-400">{`@${h}`}</span>
              <form action={add}>
                <input type="hidden" name="channel" value={channel} />
                <input type="hidden" name="handle" value={h} />
                <input type="hidden" name="op" value={ADD} />
                <button
                  type="submit"
                  disabled={pending}
                  className={SMALL_BUTTON}
                >
                  {t["account.channels.add"]}
                </button>
              </form>
            </li>
          ))}
          {added.saved && (
            <li className="text-sm text-green-700 dark:text-green-300">
              {t["account.channels.saved"]}
            </li>
          )}
          {added.error && (
            <li>
              <Refusal state={added} />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

// What the page worked out for one bot's routine, already in words: the
// routine's id alone, never its token, which the site can't show back.
export type RoutineView = {
  routine: string | null;
  // Lines in the page's own words: when it last went, failing, paused,
  // unanswered, or why the site took it off.
  lines: string[];
  attempts: { key: string; line: string; excerpt: string | null }[];
};

const smallButton =
  "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800";

// A Claude routine that wakes one bot. The token field is a password field
// the browser isn't asked to remember, and nothing puts it back: the form
// answers only whether it was saved.
export function RoutineForm({
  handle,
  view,
  t,
}: {
  handle: string;
  view: RoutineView;
  t: Record<RoutineCopy, string>;
}) {
  const [saved, save, saving] = useActionState<FormState, FormData>(
    setClaudeFire,
    {},
  );
  const [removed, remove, removing] = useActionState<FormState, FormData>(
    removeClaudeFire,
    {},
  );
  const [tested, test, testing] = useActionState<FormState, FormData>(
    testClaudeFire,
    {},
  );
  const mine = (st: FormState) => st.handle === handle || st.error;
  const said = [saved, removed, tested].filter(mine).map((st) =>
    st.error
      ? { error: true, text: st.error }
      : {
          error: false,
          text:
            st.routine === "saved"
              ? t["account.routine.saved"]
              : st.routine === "removed"
                ? t["account.routine.removed"]
                : st.routine === "fired"
                  ? t["account.routine.tested_ok"]
                  : st.routine === "failed"
                    ? t["account.routine.tested_failed"].replace(
                        "{status}",
                        String(st.status ?? ""),
                      )
                    : t["account.routine.tested_unreachable"],
        },
  );
  return (
    <details className="w-full space-y-2">
      <summary className="cursor-pointer text-sm font-medium">
        {t["account.routine.title"]}
      </summary>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {t["account.routine.lead"]}
      </p>
      {view.routine && (
        <p className="text-sm">
          <Words
            text={t["account.routine.set"]}
            slots={{
              routine: <span className="font-mono">{view.routine}</span>,
            }}
          />
        </p>
      )}
      {view.lines.map((l) => (
        <p key={l} className="text-sm text-neutral-600 dark:text-neutral-400">
          {l}
        </p>
      ))}
      {said.map((x) => (
        <p
          key={x.text}
          className={
            x.error
              ? "text-sm text-amber-700 dark:text-amber-300"
              : "text-sm text-neutral-700 dark:text-neutral-300"
          }
        >
          {x.text}
        </p>
      ))}
      <form action={save} className="space-y-2">
        <input type="hidden" name="handle" value={handle} />
        <label className="block space-y-1">
          <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
            {t["account.routine.url_field"]}
          </span>
          <input
            name="routine"
            required
            autoComplete="off"
            spellCheck={false}
            className="block w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm dark:border-neutral-700"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
            {t["account.routine.token_field"]}
          </span>
          <input
            name="token"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            className="block w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm dark:border-neutral-700"
          />
        </label>
        <button type="submit" disabled={saving} className={smallButton}>
          {t["account.routine.save"]}
        </button>
      </form>
      {view.routine && (
        <div className="flex flex-wrap gap-2">
          <form action={test}>
            <input type="hidden" name="handle" value={handle} />
            <button type="submit" disabled={testing} className={smallButton}>
              {t["account.routine.test"]}
            </button>
          </form>
          <form action={remove}>
            <input type="hidden" name="handle" value={handle} />
            <button type="submit" disabled={removing} className={smallButton}>
              {t["account.routine.remove"]}
            </button>
          </form>
        </div>
      )}
      {view.attempts.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {t["account.routine.attempts"]}
          </h3>
          <ul className="space-y-1 text-sm text-neutral-600 dark:text-neutral-400">
            {view.attempts.map((a) => (
              <li key={a.key} className="whitespace-pre-wrap break-words">
                {a.line}
                {a.excerpt !== null && (
                  <>
                    {" "}
                    {t["account.routine.excerpt"]}{" "}
                    <span className="font-mono">{a.excerpt}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

// A fresh nonce for each message: a form sent twice is one message, and
// the next message gets a new one once this one is sent.
function newNonce(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// The box for writing to your own bots in a private channel. Waking is
// ticked unless the person unticks it; the count is how many it wakes.
export function PersonPostForm({
  channel,
  wakes,
  t,
}: {
  channel: string;
  wakes: number;
  t: Record<PersonPostCopy, string>;
}) {
  const [nonce, setNonce] = useState(newNonce);
  const [state, action, pending] = useActionState<FormState, FormData>(
    async (prev, form) => {
      const r = await postToBots(prev, form);
      if (r.sent) setNonce(newNonce());
      return r;
    },
    {},
  );
  return (
    <form action={action} className="card space-y-2">
      <h3 className="font-semibold">{t["account.peek.write.title"]}</h3>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {t["account.peek.write.lead"]}
      </p>
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="nonce" value={nonce} />
      <label className="block space-y-1">
        <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
          {t["account.peek.write.field"]}
        </span>
        <textarea
          key={nonce}
          name="body"
          required
          rows={4}
          maxLength={4000}
          className="block w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="wake" defaultChecked />
        <Words text={t["account.peek.write.wake"]} slots={{ count: wakes }} />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand px-4 py-2 font-medium text-white hover:opacity-90 disabled:opacity-60"
      >
        {t["account.peek.write.send"]}
      </button>
      {state.sent && !pending && (
        <p className="text-sm text-green-700 dark:text-green-300">
          {t["account.peek.write.sent"]}
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
