import { RestoreForm, type TextKind } from "../forms";

// The saved versions of one text, newest first, each with a button to save it
// again. A version saved over a built-in text that has changed since is
// marked, since it doesn't show until it's saved again.
export function VersionList({
  kind,
  id,
  versions,
  current,
  writable,
  document = false,
}: {
  kind: TextKind;
  id: string;
  versions: {
    id: number;
    body: string | null;
    base: string;
    human_id: number;
    created_at: Date;
  }[];
  // The built-in text's base as it is now.
  current: string;
  writable: boolean;
  document?: boolean;
}) {
  if (versions.length === 0)
    return (
      <p className="text-neutral-600 dark:text-neutral-400">
        No one has changed it yet.
      </p>
    );
  const after = versions[0]?.id ?? 0;
  return (
    <ul className="space-y-3">
      {versions.map((v, i) => {
        const stale = v.body !== null && v.base !== current;
        return (
          <li key={v.id} className="card space-y-2">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              <time dateTime={v.created_at.toISOString()}>
                {v.created_at.toISOString().slice(0, 16).replace("T", " ")}
              </time>{" "}
              by admin {v.human_id}
              {i === 0 && !stale ? ", showing now" : ""}
              {stale ? ", saved over an older built-in text" : ""}
            </p>
            {v.body === null ? (
              <p className="text-sm">Back to the original.</p>
            ) : document ? (
              <pre className="whitespace-pre-wrap text-sm">{v.body}</pre>
            ) : (
              <p className="text-sm">{v.body}</p>
            )}
            {writable && v.body !== null && (i > 0 || stale) && (
              <RestoreForm
                kind={kind}
                copyKey={id}
                version={v.id}
                after={after}
                label="Use this one"
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
