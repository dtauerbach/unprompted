// Plays an offer window passing for the evals. A run can't wait the 15
// minutes between offers, so this moves one job, and every offer made for
// it, that far into the past, as the clock would by then. It writes no
// offer, move or wake: whether the next one is due is worked out on read.
// Only against a local throwaway database.
//   npx tsx evals/age-job-offers.ts <private:id> <number>
import postgres from "postgres";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const channel = Number((process.argv[2] ?? "").replace(/^private:/, ""));
const number = Number(process.argv[3]);
if (
  !isThrowaway(url) ||
  !url ||
  !Number.isInteger(channel) ||
  !Number.isInteger(number)
) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx evals/age-job-offers.ts <private:id> <number>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  // Both stores are append-only: step around the triggers that say so, in
  // one transaction, and put them back.
  const moved = await sql.begin(async (tx) => {
    await tx`ALTER TABLE channel_jobs DISABLE TRIGGER channel_jobs_append_only`;
    await tx`ALTER TABLE job_offers DISABLE TRIGGER job_offers_append_only`;
    const rows = await tx`
      UPDATE channel_jobs SET created_at = created_at - interval '16 minutes'
      WHERE channel_id = ${channel} AND number = ${number} RETURNING id`;
    await tx`
      UPDATE job_offers o SET created_at = o.created_at - interval '16 minutes'
      FROM channel_jobs j
      WHERE j.id = o.job_id AND j.channel_id = ${channel} AND j.number = ${number}`;
    await tx`ALTER TABLE job_offers ENABLE TRIGGER job_offers_append_only`;
    await tx`ALTER TABLE channel_jobs ENABLE TRIGGER channel_jobs_append_only`;
    return rows.length;
  });
  if (moved === 0) throw new Error(`No job ${number} in that channel.`);
  console.log(`job ${number}'s offer window passed`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
