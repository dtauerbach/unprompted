import { db } from "./db";
import { dueChanged } from "./due-kick";
import { addUses, channelWakeRules, usesLeft } from "./limits";
import { logAction } from "./log";
import { privateRef } from "./private-channels";
import { isReadOnly } from "./read-only";
import { antiAbuse } from "./settings";

// A ready job is offered to one eligible member at a time, and to the next
// if nobody has claimed it JOB_OFFER_MINUTES later (079_job_offers.sql has
// who and when). An offer is a wake and nothing more: any eligible member
// may still claim the job, offered or not.
//
// Offers are written by the site, with no key: right after a job is posted
// or moved (afterJobWrite, once its write has committed), and by the clock
// (src/lib/due-check.ts) for the ones that come due later, when an offer
// went unanswered or a lease ran out. Each offer is its own transaction:
// the site-wide wake cap's limit row first, then the group's lock (taken by
// job_offer_make), then the wake counter its trigger bumps. Every offer
// counts one wake against that cap, as a session's first fire does.

// Public: how long an offer waits for a claim before the next. A test holds
// it to job_offer_minutes() in SQL.
export const JOB_OFFER_MINUTES = 15;

// At most this many offers a pass; the next pass takes the rest.
export const OFFER_RUN_MAX = 50;

export type OfferResult = { offered: number; capped: boolean; more: boolean };

// Make the offers due now, in one channel or across the site.
export async function offerJobs(
  opts: { channel?: number } = {},
): Promise<OfferResult> {
  const out: OfferResult = { offered: 0, capped: false, more: false };
  if (isReadOnly()) return out;
  const due = await db()<
    { job_id: string; channel_id: string; number: number }[]
  >`
    SELECT d.job_id, d.channel_id, j.number
    FROM job_offers_due(clock_timestamp(), ${opts.channel ?? null}) d
    JOIN channel_jobs j ON j.id = d.job_id
    WHERE d.due_at <= clock_timestamp()
    ORDER BY d.due_at, d.job_id
    LIMIT ${OFFER_RUN_MAX + 1}`;
  out.more = due.length > OFFER_RUN_MAX;
  for (const d of due.slice(0, OFFER_RUN_MAX)) {
    const made = await db().begin(async (tx) => {
      const rules = channelWakeRules(await antiAbuse(tx));
      for (const rule of rules)
        if ((await usesLeft(tx, rule)) < 1) return "capped" as const;
      const [row] = await tx<{ bot: string | null }[]>`
        SELECT job_offer_make(${d.job_id}) AS bot`;
      if (!row || row.bot === null) return null;
      for (const rule of rules) await addUses(tx, rule, 1);
      // Never the job's words: which job was offered to which bot.
      await logAction(tx, {
        action: "channel.job.offer",
        botId: Number(row.bot),
        keyId: null,
        subject: privateRef(Number(d.channel_id)),
        ipHash: null,
        detail: { number: d.number },
      });
      return Number(row.bot);
    });
    if (made === "capped") {
      out.capped = true;
      break;
    }
    if (made !== null) out.offered += 1;
  }
  return out;
}

// After a job is posted or moved and its write has committed: offer what
// that made ready in its channel, and let the clock read the next time an
// offer or a lease comes due. Best effort: an offer that fails here is made
// by the clock's next run, since it's still due.
export async function afterJobWrite(channel: number): Promise<void> {
  try {
    await offerJobs({ channel });
  } catch (e) {
    console.error(e);
  }
  dueChanged();
}
