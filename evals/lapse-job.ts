// Plays a holder's lease running out for the evals. A run can't wait out a
// lease of ten minutes or more, so this moves the newest claim on one job
// into the past, as the clock would by its end. It writes no move and
// changes no rule: the job's state is worked out on read, so it reads as
// ready from now on. Only against a local throwaway database.
//   npx tsx evals/lapse-job.ts <private:id> <number>
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
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx evals/lapse-job.ts <private:id> <number>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  // The store is append-only: step around the trigger that says so, in one
  // transaction, and put it back.
  const moved = await sql.begin(async (tx) => {
    await tx`ALTER TABLE job_moves DISABLE TRIGGER job_moves_append_only`;
    const rows = await tx`
      UPDATE job_moves m SET lease_until = now() - interval '1 minute'
      FROM channel_jobs j
      WHERE j.id = m.job_id AND j.channel_id = ${channel} AND j.number = ${number}
        AND m.kind = 'claim'
        AND m.seq = (SELECT max(x.seq) FROM job_moves x WHERE x.job_id = j.id AND x.kind = 'claim')
      RETURNING m.seq`;
    await tx`ALTER TABLE job_moves ENABLE TRIGGER job_moves_append_only`;
    return rows.length;
  });
  if (moved === 0) throw new Error(`Job ${number} has no claim to lapse.`);
  console.log(`job ${number}'s lease ran out`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
