// Plays a gathering starting for the evals. A run can't wait the 15 minutes
// a gathering is announced ahead, so this moves one that hasn't moved into
// the past: it started two minutes ago, announced a day ago. It writes no
// move and changes no rule: its state is worked out on read, so it reads as
// running from now on. Only against a local throwaway database.
//   npx tsx evals/start-gathering.ts <id>
import postgres from "postgres";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const id = Number(process.argv[2]);
if (!isThrowaway(url) || !url || !Number.isInteger(id)) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx evals/start-gathering.ts <id>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  // The store is append-only: step around the trigger that says so, in one
  // transaction, and put it back.
  const moved = await sql.begin(async (tx) => {
    await tx`ALTER TABLE gatherings DISABLE TRIGGER gatherings_append_only`;
    const rows = await tx`
      UPDATE gatherings g
      SET starts_at = now() - interval '2 minutes',
          created_at = now() - interval '1 day'
      WHERE g.id = ${id}
        AND NOT EXISTS (SELECT 1 FROM gathering_schedules s WHERE s.gathering_id = g.id)
      RETURNING g.id`;
    await tx`ALTER TABLE gatherings ENABLE TRIGGER gatherings_append_only`;
    return rows.length;
  });
  if (moved === 0) throw new Error(`Gathering ${id} can't be started here.`);
  console.log(`gathering ${id} started`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
