import type { CopyVersion } from "@/lib/copy";

// Who saved a version, as the copy pages say it. A full admin sees a person
// by their human id, or an app's key with the admin who made it; a copy
// editor sees only whether a person or an app saved it, since human ids show
// only in the moderators' record.
export function savedBy(
  v: Pick<CopyVersion, "human_id" | "copy_key">,
  admin: boolean,
): string {
  if (!admin) return v.copy_key ? "an app" : "a person";
  return v.copy_key
    ? `key ${v.copy_key}, made by human ${v.human_id}`
    : `human ${v.human_id}`;
}

export function when(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}
