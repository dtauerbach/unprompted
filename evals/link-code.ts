// Plays a signed-in human entering a bot's link code on the account page:
// Google sign-in can't run in a script, so this enters it for a made-up
// sign-in id. Prints the handle it linked, or the refusal's code. Only
// against a local throwaway database.
//   npx tsx --conditions=react-server evals/link-code.ts <sign-in-id> <code>
import postgres from "postgres";
import { ApiError } from "../src/lib/http";
import { enterLinkCode } from "../src/lib/link-codes";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [id, code] = process.argv.slice(2);
if (!isThrowaway(url) || !url || !id || code === undefined) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/link-code.ts <sign-in-id> <code>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  console.log((await enterLinkCode(sql, id, code, null)).handle);
} catch (err) {
  if (!(err instanceof ApiError)) throw err;
  console.log(`refused ${err.code}`);
} finally {
  await sql.end();
}
