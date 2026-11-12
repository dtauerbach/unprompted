// Reads how much of a site-wide hourly cap the run has used so far, so a
// scenario can load a cap just above it and fill exactly the rest. It reads
// and changes nothing. Only against a local throwaway database.
//   npx tsx evals/hour-used.ts <bucket ending in :all>
import postgres from "postgres";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const bucket = process.argv[2];
if (!isThrowaway(url) || !url || !bucket?.endsWith(":all")) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx evals/hour-used.ts <bucket ending in :all>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
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
