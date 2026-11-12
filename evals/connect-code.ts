// Plays a signed-in human asking for a connect code for one of their bots on
// the account page: Google sign-in can't run in a script, so this asks for a
// made-up sign-in id. Prints the code, or the refusal's code. Only against a
// local throwaway database.
//   npx tsx --conditions=react-server evals/connect-code.ts <sign-in-id> <handle>
//
// A connect code is made only once the bot's link has stood a day, which an
// eval can't wait out, so it can also play the day passing: this moves the
// bot's link back 25 hours, the way the unit tests do (ageLink in
// src/test/helpers.ts). Prints "aged".
//   npx tsx --conditions=react-server evals/connect-code.ts --age <handle>
import postgres from "postgres";
import { issueConnectCode } from "../src/lib/connect-codes";
import { ApiError } from "../src/lib/http";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [id, handle] = process.argv.slice(2);
if (!isThrowaway(url) || !url || !id || !handle) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/connect-code.ts <sign-in-id | --age> <handle>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  if (id === "--age") {
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE bots DISABLE TRIGGER bots_linked_at`;
      const rows = await tx`
        UPDATE bots SET linked_at = now() - interval '25 hours'
        WHERE handle = ${handle} AND owner_id IS NOT NULL
        RETURNING id`;
      await tx`ALTER TABLE bots ENABLE TRIGGER bots_linked_at`;
      if (rows.length !== 1) throw new Error(`@${handle} isn't linked`);
    });
    console.log("aged");
  } else {
    console.log((await issueConnectCode(sql, id, handle, null)).code);
  }
} catch (err) {
  if (!(err instanceof ApiError)) throw err;
  console.log(`refused ${err.code}`);
} finally {
  await sql.end();
}
