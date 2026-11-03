"use client";

import { useActionState, useState } from "react";
import {
  type AdminFormState,
  type ModKeyFormState,
  makeModKeyAction,
  revokeModKeyAction,
} from "./actions";

const BUTTON =
  "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800";
const INPUT =
  "w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900";

// The name the moderator service reads each role's key under.
const VARIABLE: Record<string, string> = {
  moderator: "UNPROMPTED_MOD_KEY",
  appeals: "UNPROMPTED_APPEALS_KEY",
};

function Note({ state }: { state: AdminFormState }) {
  if (state.error)
    return (
      <p className="text-sm text-amber-700 dark:text-amber-300">
        {state.error}
      </p>
    );
  if (state.message)
    return (
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {state.message}
      </p>
    );
  return null;
}

// The key, once, with the variable to paste it into. It lives only in this
// page's memory: reloading the page loses it, and the site can't show it
// again.
function NewKey({ secret, role }: { secret: string; role?: string }) {
  const [copied, setCopied] = useState(false);
  const variable = role ? VARIABLE[role] : undefined;
  return (
    <div className="space-y-2 rounded-md border border-amber-300 p-3 dark:border-amber-800">
      <p className="text-sm">
        {variable
          ? `Paste this into the moderator service's ${variable} variable.`
          : "Paste this into the moderator service."}
      </p>
      <input
        readOnly
        value={secret}
        aria-label="The new moderator key"
        onFocus={(e) => e.currentTarget.select()}
        className={`${INPUT} font-mono`}
      />
      <button
        type="button"
        className={BUTTON}
        onClick={async () => {
          await navigator.clipboard.writeText(secret);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function MakeModKeyForm() {
  const [state, action, pending] = useActionState<ModKeyFormState, FormData>(
    makeModKeyAction,
    {},
  );
  return (
    <form action={action} className="max-w-xl space-y-2">
      <div className="flex flex-wrap gap-2">
        <select
          name="role"
          aria-label="Role"
          defaultValue="moderator"
          className={`${INPUT} max-w-40`}
        >
          <option value="moderator">moderator</option>
          <option value="appeals">appeals</option>
        </select>
        <input
          name="label"
          placeholder="Label, like moderator-1"
          aria-label="Label"
          required
          maxLength={30}
          className={`${INPUT} max-w-56`}
        />
      </div>
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
      </button>
      <Note state={state} />
      {state.secret && <NewKey secret={state.secret} role={state.role} />}
    </form>
  );
}

export function RevokeModKeyForm({ id }: { id: number }) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    revokeModKeyAction,
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
