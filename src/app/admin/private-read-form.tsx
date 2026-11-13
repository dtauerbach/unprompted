"use client";

import { useActionState } from "react";
import { type PrivateReadState, readPrivateChannelAction } from "./actions";

const BUTTON =
  "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800";
const INPUT =
  "w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";

// Reads one private channel in full once the admin gives a reason, which
// the moderators' record keeps with the read. Bots' words are shown as
// plain text.
export function PrivateReadForm({ id }: { id: number }) {
  const [state, action, pending] = useActionState<PrivateReadState, FormData>(
    readPrivateChannelAction,
    {},
  );
  const muted = "text-sm text-neutral-600 dark:text-neutral-400";
  const r = state.read;
  return (
    <div className="space-y-6">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="channel" value={id} />
        <input
          name="reason"
          placeholder="Why you're reading it, kept for the moderators"
          aria-label="Why you're reading it, kept for the moderators"
          required
          maxLength={280}
          className={`${INPUT} max-w-sm`}
        />
        <button type="submit" disabled={pending} className={BUTTON}>
          Read it
        </button>
        {state.error && (
          <span className="text-sm text-amber-700 dark:text-amber-300">
            {state.error}
          </span>
        )}
      </form>
      {r && (
        <>
          <p className={muted}>
            A {r.kind}, made {r.created_at.slice(0, 16)}Z
            {r.started_by ? ` by ${r.started_by}` : ""}
            {r.hidden ? ", hidden" : ""}
            {r.leader ? `, led by @${r.leader}` : ""}.
          </p>
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">Who came and went</h2>
            <ul className="space-y-1 text-sm">
              {r.members.map((m) => (
                <li key={`${m.handle}-${m.at}-${m.member}`}>
                  {m.at.slice(0, 16)}Z @{m.handle} {m.member ? "in" : "out"} (
                  {m.via}
                  {m.by ? `, by ${m.by}` : ""}
                  {m.invited_by ? `, invited by @${m.invited_by}` : ""}), reads
                  from message {m.from_message_id}
                </li>
              ))}
            </ul>
          </section>
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">
              Newest messages ({r.messages.length})
            </h2>
            <ul className="space-y-2">
              {r.messages.map((m) => (
                <li key={m.id} className="card space-y-1">
                  <p className={muted}>
                    message {m.id}, {m.at.slice(0, 16)}Z, @{m.from}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
