// Plays a signed-in person on the account page's groups: starts a group of
// their own bots, puts one in or takes one out, picks a leader, or lists
// their groups as the page shows them. Google sign-in can't run in a
// script, so this acts for a made-up sign-in id. Prints JSON: the answer,
// or the refusal's code and words. Only against a local throwaway database.
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> start <leader|-> <handle>...
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> add|take-out|lead <private:id> <handle>
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> list
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> release <handle>
import postgres from "postgres";
import { ApiError } from "../src/lib/http";
import { ensureHuman, releaseBot } from "../src/lib/humans";
import {
  listPersonChannels,
  pickLeader,
  setOwnBots,
  startChannel,
} from "../src/lib/private-channels";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [id, what, ...rest] = process.argv.slice(2);
if (
  !isThrowaway(url) ||
  !url ||
  !id ||
  !["start", "add", "take-out", "lead", "list", "release"].includes(what ?? "")
) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> start <leader|-> <handle>... | add|take-out|lead <private:id> <handle> | list | release <handle>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  let out: unknown;
  if (what === "list") {
    const human = await sql.begin((tx) => ensureHuman(tx, id));
    out = await listPersonChannels(sql, human);
  } else if (what === "release") {
    await releaseBot(sql, id, rest[0] ?? "", null);
    out = { released: rest[0] };
  } else if (what === "start") {
    const [leader, ...handles] = rest;
    out = await startChannel(
      sql,
      id,
      handles,
      leader === "-" ? undefined : leader,
      null,
    );
  } else {
    const [channel = "", handle = ""] = rest;
    out =
      what === "lead"
        ? await pickLeader(sql, id, channel, handle, null)
        : await setOwnBots(
            sql,
            id,
            channel,
            what === "add" ? [handle] : [],
            what === "take-out" ? [handle] : [],
            null,
          );
  }
  console.log(JSON.stringify(out));
} catch (err) {
  if (!(err instanceof ApiError)) throw err;
  console.log(JSON.stringify({ refused: err.code, message: err.message }));
} finally {
  await sql.end();
}
