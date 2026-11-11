"use client";

import { useActionState, useEffect, useState } from "react";
import {
  type AdminFormState,
  type CopyKeyFormState,
  makeCopyKeyAction,
  revokeCopyKeyAction,
  undoCopyAction,
} from "./actions";

const BUTTON =
  "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800";
const INPUT =
  "w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900";

function Note({ state }: { state: AdminFormState }) {
  if (state.error)
    return (
      <span className="text-sm text-amber-700 dark:text-amber-300">
        {state.error}
      </span>
    );
  if (state.message)
    return (
      <span className="text-sm text-neutral-600 dark:text-neutral-400">
        {state.message}
      </span>
    );
  return null;
}

export function UndoForm({ version }: { version: number }) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    undoCopyAction,
    {},
  );
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="version" value={version} />
      <button type="submit" disabled={pending} className={BUTTON}>
        Undo
      </button>
      <Note state={state} />
    </form>
  );
}

// The connector's address, once. It lives only in this page's memory:
// reloading loses it, and the site can't show it again.
function NewAddress({ secret }: { secret: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const address = `${origin}/copy/mcp/${secret}`;
  return (
    <div className="space-y-2 rounded-md border border-amber-300 p-3 dark:border-amber-800">
      <p className="text-sm">
        Add this address as a custom connector in the app. Anyone who has it can
        change the words, so keep it out of chats and files. An app that can
        send a header should use {origin}/copy/mcp instead, with the key (the
        address's last part, from unpcopy_) as Authorization: Bearer, which
        keeps it out of request logs.
      </p>
      <input
        readOnly
        value={address}
        aria-label="The new connector address"
        onFocus={(e) => e.currentTarget.select()}
        className={`${INPUT} font-mono`}
      />
      <button
        type="button"
        className={BUTTON}
        onClick={async () => {
          await navigator.clipboard.writeText(address);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// Each submit starts from an empty state, so a key just shown never travels
// back to the server as the previous state.
const makeFresh = (_prev: CopyKeyFormState, form: FormData) =>
  makeCopyKeyAction({}, form);

export function MakeCopyKeyForm() {
  const [state, action, pending] = useActionState<CopyKeyFormState, FormData>(
    makeFresh,
    {},
  );
  return (
    <form action={action} className="max-w-xl space-y-2">
      <input
        name="label"
        placeholder="Label, like assistant"
        aria-label="Label"
        required
        maxLength={30}
        className={`${INPUT} max-w-56`}
      />
      <input
        name="reason"
        placeholder="Reason, kept for the moderators"
        aria-label="Reason, kept for the moderators"
        required
        maxLength={280}
        className={INPUT}
      />
      <button type="submit" disabled={pending} className={BUTTON}>
        Make key
      </button>{" "}
      <Note state={state} />
      {state.secret && <NewAddress secret={state.secret} />}
    </form>
  );
}

export function RevokeCopyKeyForm({ id }: { id: number }) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    revokeCopyKeyAction,
    {},
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input
        name="reason"
        placeholder="Reason, kept for the moderators"
        aria-label="Reason, kept for the moderators"
        required
        maxLength={280}
        className={`${INPUT} max-w-sm`}
      />
      <button
        type="submit"
        disabled={pending}
        className={`${BUTTON} border-red-400 text-red-700 dark:border-red-800 dark:text-red-300`}
      >
        Revoke
      </button>
      <Note state={state} />
    </form>
  );
}
