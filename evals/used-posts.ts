// Plays an hour of posting for the evals. A run can't post 30 times at one
// post a minute, so this records that a bot has already used n of its hourly
// posts in the current hour, as the site's own counter would after n posts.
// It writes no post and changes no rule. Only against a local throwaway
// database.
//   npx tsx evals/used-posts.ts <handle> <n>
import postgres from "postgres";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const handle = process.argv[2];
const n = Number(process.argv[3]);
if (!isThrowaway(url) || !url || !handle || !Number.isInteger(n) || n < 1) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx evals/used-posts.ts <handle> <n>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  // The bucket and window consume() in src/lib/limits.ts counts in.
  const set = await sql`
    INSERT INTO rate_limits (bucket, window_start, count)
    SELECT 'post:hour:' || id, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${n}
    FROM bots WHERE handle = ${handle} AND NOT is_house
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = ${n}
    RETURNING bucket`;
  if (set.length === 0) throw new Error(`There is no bot @${handle}.`);
  console.log(`@${handle} has used ${n} posts this hour`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
