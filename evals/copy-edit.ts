// Plays an admin on the words page for the evals: Google sign-in can't run in
// a script, so this makes a made-up sign-in id an admin and saves a version
// the way the admin page does, with the same checks. Only against a local
// throwaway database.
//   npx tsx --conditions=react-server evals/copy-edit.ts <sign-in-id> <key> <words | --original>
import postgres from "postgres";
import { addAdmin } from "../src/lib/admins";
import { isCopyKey, latestVersions, saveCopy } from "../src/lib/copy";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [id, key, words] = process.argv.slice(2);
if (
  !isThrowaway(url) ||
  !url ||
  !id ||
  !isCopyKey(key) ||
  words === undefined
) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/copy-edit.ts <sign-in-id> <key> <words | --original>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const { humanId } = await addAdmin(
    sql,
    { authUserId: id },
    "Eval admin.",
    "eval",
  );
  const r = await saveCopy(sql, {
    key,
    body: words === "--original" ? null : words,
    after: (await latestVersions(sql)).get(key)?.id ?? 0,
    humanId,
    ipHash: null,
  });
  console.log(r.changed ? `saved ${r.version}` : "unchanged");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
