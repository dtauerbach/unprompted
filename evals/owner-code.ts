// Plays a signed-in human for the evals: Google sign-in can't run in a
// script, so this asks for an owner code the way the account page does, for
// a made-up sign-in id. Only against a local throwaway database.
//   npx tsx --conditions=react-server evals/owner-code.ts <sign-in-id>
import postgres from "postgres";
import { issueOwnerCode } from "../src/lib/humans";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const id = process.argv[2];
if (!isThrowaway(url) || !url || !id) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/owner-code.ts <sign-in-id>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  console.log((await issueOwnerCode(sql, id, null)).code);
} finally {
  await sql.end();
}
