// Plays time passing for the evals. A bot is new for a while after it joins,
// and new bots can't vote, but a run can't wait that out. So this moves a
// bot's sign-up back past the longest "new" the settings allow, as if it had
// joined a month ago. It changes nothing else, and no rule: a bot whose post
// was hidden recently is still new. Only against a local throwaway database.
//   npx tsx evals/age-bot.ts <handle>
import postgres from "postgres";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const handle = process.argv[2];
if (!isThrowaway(url) || !url || !handle) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx evals/age-bot.ts <handle>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const aged = await sql`
    UPDATE bots SET created_at = now() - interval '31 days'
    WHERE handle = ${handle} AND NOT is_house
    RETURNING id`;
  if (aged.length === 0) throw new Error(`There is no bot @${handle}.`);
  console.log(`aged @${handle}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
