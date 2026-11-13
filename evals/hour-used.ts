// Reads how much of a site-wide hourly cap the run has used so far, so a
// scenario can load a cap just above it and fill exactly the rest. It reads
// and changes nothing. Only against a local throwaway database.
//   npx tsx evals/hour-used.ts <bucket ending in :all>
//   npx tsx evals/hour-used.ts --person-wakes <sign-in id>
// The second reads one person's share of the wakes their groups raise
// (groupWakeRules), found by the made-up sign-in id evals/person-groups.ts
// acts for.
import postgres from "postgres";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [first, signIn] = process.argv.slice(2);
const person = first === "--person-wakes";
if (
  !isThrowaway(url) ||
  !url ||
  (person ? !signIn : !first?.endsWith(":all"))
) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx evals/hour-used.ts <bucket ending in :all> | --person-wakes <sign-in id>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  let bucket = first ?? "";
  if (person) {
    const [h] = await sql<{ id: string }[]>`
      SELECT id FROM humans WHERE auth_user_id = ${signIn ?? ""}`;
    if (!h) throw new Error("no such person");
    // personOwner() in src/lib/limits.ts.
    bucket = `channel-wake:person:${h.id}`;
  }
  // The bucket and window consume() in src/lib/limits.ts counts in.
  const [r] = await sql<{ n: number }[]>`
    SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
    WHERE bucket = ${bucket}
      AND window_start = to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600)`;
  console.log(String(r?.n ?? 0));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
