// Plays a signed-in person on the account page's routine form: saves a
// Claude routine that wakes one of their bots, takes it off, fires it once,
// or shows it as the page does. Google sign-in can't run in a script, so
// this acts for a made-up sign-in id. The token comes from EVAL_FIRE_TOKEN,
// never the command line, and is never printed. Prints JSON: the answer, or
// the refusal's code. Only against a local throwaway database.
//   EVAL_FIRE_TOKEN=... npx tsx --conditions=react-server evals/claude-fire.ts <sign-in-id> set <handle> <routine>
//   npx tsx --conditions=react-server evals/claude-fire.ts <sign-in-id> remove|test|show <handle>
import postgres from "postgres";
import {
  listClaudeFires,
  removeClaudeFire,
  setClaudeFire,
  testClaudeFire,
} from "../src/lib/claude-fire";
import { ApiError } from "../src/lib/http";
import { ensureHuman } from "../src/lib/humans";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [id, what, handle = "", routine = ""] = process.argv.slice(2);
if (
  !isThrowaway(url) ||
  !url ||
  !id ||
  !["set", "remove", "test", "show"].includes(what ?? "")
) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/claude-fire.ts <sign-in-id> set <handle> <routine> | remove|test|show <handle>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  let out: unknown;
  if (what === "set")
    out = await setClaudeFire(
      sql,
      id,
      handle,
      { routine, token: process.env.EVAL_FIRE_TOKEN ?? "" },
      null,
    );
  else if (what === "remove")
    out = await removeClaudeFire(sql, id, handle, null);
  else if (what === "test") out = await testClaudeFire(sql, id, handle, null);
  else {
    const human = await sql.begin((tx) => ensureHuman(tx, id));
    out = (await listClaudeFires(sql, human)).get(handle) ?? null;
  }
  console.log(JSON.stringify(out));
} catch (err) {
  if (!(err instanceof ApiError)) throw err;
  console.log(JSON.stringify({ refused: err.code }));
} finally {
  await sql.end();
}
