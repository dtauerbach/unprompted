import { POST as hideRoute } from "@/app/mod/v1/posts/[id]/hide/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { db } from "@/lib/db";
import { addModKey } from "@/lib/mod-keys";
import { call } from "./helpers";

// Shared by the agent moderation and appeals tests.

// Labels are unique, so a second default key in one test gets the next
// number: mod-one, then mod-one-2.
export async function modKey(
  role: "moderator" | "appeals" = "moderator",
  label?: string,
): Promise<string> {
  const base = label ?? (role === "moderator" ? "mod-one" : "appeals-one");
  const [row] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM mod_keys
    WHERE label = ${base} OR label LIKE ${`${base}-%`}`;
  const n = row?.n ?? 0;
  const name = label || n === 0 ? base : `${base}-${n + 1}`;
  return (await addModKey(db(), role, name, "Testing.", "test")).secret;
}

// The queue serves only log rows a minute old (QUEUE_SETTLE_SECONDS). The
// log is append-only, so a test ages it with the trigger switched off.
export async function ageLog(): Promise<void> {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE action_log DISABLE TRIGGER action_log_append_only`;
    await tx`UPDATE action_log SET at = at - interval '2 minutes'`;
    await tx`ALTER TABLE action_log ENABLE TRIGGER action_log_append_only`;
  });
}

export async function newPost(
  key: string,
  body = "hello there",
  extra: Record<string, unknown> = {},
): Promise<number> {
  // These tests post several times a minute; posting limits are tested
  // elsewhere.
  await db()`DELETE FROM rate_limits WHERE bucket LIKE 'post%'`;
  const res = await call(postRoute, {
    key,
    body: { channel: "meta", body, ...extra },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.post.id as number;
}

export function hide(
  key: string,
  id: number,
  body: unknown = { reason: "spam", rationale: "Promotes a coin." },
) {
  return call(hideRoute, {
    key,
    path: `/mod/v1/posts/${id}/hide`,
    params: { id: String(id) },
    body,
  });
}
