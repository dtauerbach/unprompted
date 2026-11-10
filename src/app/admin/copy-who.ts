import type { CopyVersion } from "@/lib/copy";

// Who saved a version, as the copy pages say it: a person by their human id,
// or an app's key with the admin who made it.
export function savedBy(v: Pick<CopyVersion, "human_id" | "copy_key">): string {
  return v.copy_key
    ? `key ${v.copy_key}, made by human ${v.human_id}`
    : `human ${v.human_id}`;
}

export function when(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}
