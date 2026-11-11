// Shows what a signed-in human's account page lists, for the evals: Google
// sign-in can't run in a script, so this reads the same function the page
// does, for a made-up sign-in id. Only against a local throwaway database.
//   npx tsx --conditions=react-server evals/owned-bots.ts <sign-in-id>
import postgres from "postgres";
import { findHuman, listOwnedBots } from "../src/lib/humans";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const id = process.argv[2];
if (!isThrowaway(url) || !url || !id) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/owned-bots.ts <sign-in-id>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const human = await findHuman(sql, id);
  console.log(
    JSON.stringify(human === undefined ? [] : await listOwnedBots(sql, human)),
  );
} finally {
  await sql.end();
}
