import { db } from "./db";
import { dueChanged } from "./due-kick";
import { noticeJobOfferFailures } from "./floods";
import { addUses, channelWakeRules, usesLeft } from "./limits";
import { logAction } from "./log";
import { privateRef, refId } from "./private-channels";
import { isReadOnly } from "./read-only";
import { antiAbuse } from "./settings";

// A ready job is offered to one eligible member at a time, and to the next
// if nobody has claimed it JOB_OFFER_MINUTES later (079_job_offers.sql has
// who and when). An offer is a wake and nothing more: any eligible member
// may still claim the job, offered or not. Once every member that could take
// it was offered it and nobody claimed it, the group's leader is woken, once
// an episode (080_job_no_taker.sql), and reads `no_taker` on the job.
//
// Offers are written by the site, with no key: right after a job is posted
// or moved (afterJobWrite, once its write has committed), and by the clock
// (src/lib/due-check.ts) for the ones that come due later, when an offer
// went unanswered or a lease ran out. Each offer is its own transaction:
// the site-wide wake cap's limit row first, then the group's lock (taken by
// job_offer_make), then the wake counter its trigger bumps. Every offer
// counts one wake against that cap, as a session's first fire does, and so
// does each leader wake.

// Public: how long an offer waits for a claim before the next. A test holds
// it to job_offer_minutes() in SQL.
export const JOB_OFFER_MINUTES = 15;

// At most this many offers a pass; the next pass takes the rest.
export const OFFER_RUN_MAX = 50;

// offered: members offered a job; leaders: leaders woken because nobody
// was left to offer one.
export type OfferResult = {
  offered: number;
  leaders: number;
  capped: boolean;
  more: boolean;
};

type Due = {
  kind: "offer" | "leader";
  job_id: string;
  channel_id: string;
  number: number;
};

// Make the offers due now, in one channel or across the site, stopping at
// `until` (ms since the epoch) if given, so the clock's round keeps its
// deadline; what's left is still due for the next pass. One offer that
// throws (a bot frozen between the read and the insert's own check, a lost
// connection) is logged and passed over, so it never stops the others.
export async function offerJobs(
  opts: { channel?: number; until?: number } = {},
): Promise<OfferResult> {
  const out: OfferResult = {
    offered: 0,
    leaders: 0,
    capped: false,
    more: false,
  };
  if (isReadOnly()) return out;
  const only = opts.channel ?? null;
  const due = await db()<Due[]>`
    SELECT d.kind, d.job_id, d.channel_id, j.number FROM (
      SELECT 'offer' AS kind, o.job_id, o.channel_id, o.due_at
      FROM job_offers_due(clock_timestamp(), ${only}) o
      UNION ALL
      SELECT 'leader', n.job_id, n.channel_id, n.due_at
      FROM job_no_takers_due(clock_timestamp(), ${only}) n
    ) d
    JOIN channel_jobs j ON j.id = d.job_id
    WHERE d.due_at <= clock_timestamp()
    ORDER BY d.due_at, d.job_id, d.kind DESC
    LIMIT ${OFFER_RUN_MAX + 1}`;
  out.more = due.length > OFFER_RUN_MAX;
  let failed = 0;
  for (const d of due.slice(0, OFFER_RUN_MAX)) {
    if (opts.until !== undefined && Date.now() >= opts.until) {
      out.more = true;
      break;
    }
    const made = await offerOne(d).catch((e: unknown) => {
      console.error(e);
      // A write that landed between the read and the insert (a claim, a
      // freeze) leaves nothing due, which is no failure.
      if ((e as { code?: string }).code !== "UPR01") failed += 1;
      return null;
    });
    if (made === "capped") {
      out.capped = true;
      break;
    }
    if (made !== null) out[d.kind === "offer" ? "offered" : "leaders"] += 1;
  }
  // Every one due failed: a line for the moderators, at most once an hour,
  // since the clock tries again each minute while they stay due.
  if (failed > 0 && out.offered + out.leaders === 0)
    await noticeJobOfferFailures(failed).catch((e: unknown) =>
      console.error(e),
    );
  return out;
}

async function offerOne(d: Due): Promise<number | "capped" | null> {
  return db().begin(async (tx) => {
    const rules = channelWakeRules(await antiAbuse(tx));
    for (const rule of rules)
      if ((await usesLeft(tx, rule)) < 1) return "capped" as const;
    const [row] =
      d.kind === "offer"
        ? await tx<{ bot: string | null }[]>`
            SELECT job_offer_make(${d.job_id}) AS bot`
        : await tx<{ bot: string | null }[]>`
            SELECT job_no_taker_make(${d.job_id}) AS bot`;
    if (!row || row.bot === null) return null;
    for (const rule of rules) await addUses(tx, rule, 1);
    // Never the job's words: which job was offered to which bot, or which
    // leader was told nobody took it.
    await logAction(tx, {
      action: d.kind === "offer" ? "channel.job.offer" : "channel.job.no_taker",
      botId: Number(row.bot),
      keyId: null,
      subject: privateRef(Number(d.channel_id)),
      ipHash: null,
      detail: { number: d.number },
    });
    return Number(row.bot);
  });
}

// The clock owns overdue dispatch; ordinary job writes keep the offer path
// unchanged. Take the same wake-limit lock before the channel lock. SQL
// rechecks the rung and current recipient under that lock: at cap it can
// record an eligible no-wake rung but leaves any actual wake pending.
export async function sweepJobOverdue(until: number): Promise<number> {
  if (isReadOnly() || Date.now() >= until) return 0;
  const due = await db()<{ job_id: string; rung: number }[]>`
    SELECT d.job_id, d.rung
    FROM job_overdue_due(clock_timestamp()) d
    WHERE d.rung IN (1, 2) AND d.due_at <= clock_timestamp()
    ORDER BY d.due_at, d.job_id
    LIMIT ${OFFER_RUN_MAX}`;
  let wakes = 0;
  for (const d of due) {
    if (Date.now() >= until) break;
    const woken = await db()
      .begin(async (tx) => {
        const rules = channelWakeRules(await antiAbuse(tx));
        let allowed = true;
        for (const rule of rules)
          if ((await usesLeft(tx, rule)) < 1) allowed = false;
        const [row] = await tx<{ woken: boolean }[]>`
          SELECT woken FROM job_overdue_make(${d.job_id}, ${d.rung}, ${allowed})`;
        if (!row?.woken) return false;
        for (const rule of rules) await addUses(tx, rule, 1);
        return true;
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code !== "UPR01") console.error(e);
        return false;
      });
    if (woken) wakes += 1;
  }
  return wakes;
}

// After a job is posted or moved, or a member is put in its channel, and the
// write has committed: offer what that made due in its channel (a member
// put in may be owed an offer at once), and let the clock read the next
// time an offer, a leader wake or a lease comes due. Best effort: an offer that fails here is made
// by the clock's next run, since it's still due.
// A bot's link ending takes it out of every group it's in
// (releaseFromGroups): each may owe a job's offer now, its holder gone
// (081_job_holder_gone.sql). Run after the release commits.
export async function afterGroupsLeft(refs: string[]): Promise<void> {
  for (const ref of refs) {
    const id = refId(ref);
    if (id !== undefined) await afterJobWrite(id);
  }
}

export async function afterJobWrite(channel: number): Promise<void> {
  try {
    await offerJobs({ channel });
  } catch (e) {
    console.error(e);
  }
  dueChanged();
}
