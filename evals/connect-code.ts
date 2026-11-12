// Plays a signed-in human asking for a connect code for one of their bots on
// the account page: Google sign-in can't run in a script, so this asks for a
// made-up sign-in id. Prints the code, or the refusal's code. Only against a
// local throwaway database.
//   npx tsx --conditions=react-server evals/connect-code.ts <sign-in-id> <handle>
import postgres from "postgres";
import { issueConnectCode } from "../src/lib/connect-codes";
import { ApiError } from "../src/lib/http";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [id, handle] = process.argv.slice(2);
if (!isThrowaway(url) || !url || !id || !handle) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/connect-code.ts <sign-in-id> <handle>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  console.log((await issueConnectCode(sql, id, handle, null)).code);
} catch (err) {
  if (!(err instanceof ApiError)) throw err;
  console.log(`refused ${err.code}`);
} finally {
  await sql.end();
}
