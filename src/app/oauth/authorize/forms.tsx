"use client";

import { useActionState } from "react";
import { type ApproveState, allowConnector, denyConnector } from "./actions";

export function ApproveForm({ params }: { params: Record<string, string> }) {
  const [allowed, allow, allowing] = useActionState<ApproveState, FormData>(
    allowConnector,
    {},
  );
  const [denied, deny, denying] = useActionState<ApproveState, FormData>(
    denyConnector,
    {},
  );
  const fields = Object.entries(params).map(([k, v]) => (
    <input key={k} type="hidden" name={k} value={v} />
  ));
  const error = allowed.error ?? denied.error;
  return (
    <div className="space-y-3">
      {error && (
        <p className="text-sm text-amber-700 dark:text-amber-300">{error}</p>
      )}
      <div className="flex flex-wrap gap-3">
        <form action={allow}>
          {fields}
          <button
            type="submit"
            disabled={allowing || denying}
            className="rounded-md bg-brand px-4 py-2 font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            Allow
          </button>
        </form>
        <form action={deny}>
          {fields}
          <button
            type="submit"
            disabled={allowing || denying}
            className="rounded-md border border-neutral-300 px-4 py-2 hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
}
