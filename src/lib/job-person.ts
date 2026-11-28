import type postgres from "postgres";
import { db } from "./db";
import { ApiError } from "./http";
import { logAction } from "./log";
import { personPushAllowed, vapidConfig } from "./person-push";
import { noSuchChannel, privateRef } from "./private-channels";
import { isReadOnly } from "./read-only";
import { assertWritable } from "./settings";

export async function setJobOverdueOptIn(
  sql: postgres.Sql,
  authId: string,
  channel: number,
  enabled: boolean,
  ipHash: string | null,
): Promise<void> {
  if (enabled) assertWritable();
  await sql.begin(async (tx) => {
    const [human] = await tx<{ id: string }[]>`
      SELECT id FROM humans WHERE auth_user_id = ${authId}`;
    if (!human) throw noSuchChannel();
    await tx`SELECT lock_private_channel(${channel})`;
    const [c] = await tx<{ allowed: boolean; opted: boolean }[]>`
      SELECT job_overdue_person_can_read(${human.id}, ${channel}) AS allowed,
             job_overdue_person_opted(${human.id}, ${channel}) AS opted`;
    if (!c?.allowed && (enabled || !c?.opted)) throw noSuchChannel();
    if (c.opted === enabled) return;
    if (enabled && !personPushAllowed())
      throw new ApiError(409, "push_unavailable", "Push is unavailable here.");
    await tx`
      INSERT INTO job_overdue_person_choices (human_id, channel_id, enabled)
      VALUES (${human.id}, ${channel}, ${enabled})`;
    await logAction(tx, {
      action: "human.job_overdue_push.set",
      humanId: Number(human.id),
      botId: null,
      keyId: null,
      subject: privateRef(channel),
      ipHash,
      detail: { enabled },
    });
  });
}

// The bot sweep never consumes rung 3. The person clock uses this
// separate bounded pass, with no bot wake budget or counter involved.
export async function sweepJobPersonOverdue(until: number): Promise<number> {
  if (isReadOnly() || !personPushAllowed() || !vapidConfig()) return 0;
  const sql = db();
  const due = await sql<
    { job_id: string; channel_id: string; number: number }[]
  >`
    SELECT d.job_id, d.channel_id, j.number FROM job_overdue_due(now()) d
    JOIN channel_jobs j ON j.id = d.job_id
    WHERE d.rung = 3 AND d.due_at <= clock_timestamp()
    ORDER BY d.due_at, d.job_id LIMIT 20`;
  let queued = 0;
  for (const d of due) {
    if (Date.now() >= until) break;
    const didQueue = await sql
      .begin(async (tx) => {
        const [made] =
          await tx`SELECT rung FROM job_overdue_make(${d.job_id}, 3, false)`;
        if (!made) return false;
        const [target] = await tx<{ human: string | null }[]>`
        SELECT job_overdue_person_target(${d.job_id}) AS human`;
        const h = target?.human ?? null;
        if (h !== null) {
          await tx`
          INSERT INTO job_overdue_person_notices (job_id, human_id, channel_id)
          VALUES (${d.job_id}, ${h}, ${d.channel_id})`;
        }
        await logAction(tx, {
          action: "channel.job.overdue",
          botId: null,
          keyId: null,
          subject: privateRef(Number(d.channel_id)),
          ipHash: null,
          detail: {
            number: d.number,
            rung: 3,
            woken: false,
            queued: h !== null,
          },
        });
        return h !== null;
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code !== "UPR01") console.error(e);
        return false;
      });
    if (didQueue) queued += 1;
  }
  return queued;
}
