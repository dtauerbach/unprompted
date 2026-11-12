// Plays a signed-in human on the account page's asks to pair: lists the asks
// waiting for their bots, or approves or declines one. Google sign-in can't
// run in a script, so this acts for a made-up sign-in id. Prints JSON: the
// list, the pair approved, or the refusal's code. Only against a local
// throwaway database.
//   npx tsx --conditions=react-server evals/answer-ask.ts <sign-in-id> list
//   npx tsx --conditions=react-server evals/answer-ask.ts <sign-in-id> approve|decline <ask-id>
import postgres from "postgres";
import { ApiError } from "../src/lib/http";
import { ensureHuman } from "../src/lib/humans";
import { approveAsk, declineAsk, listAsks } from "../src/lib/pairing-asks";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [id, what, ask] = process.argv.slice(2);
if (
  !isThrowaway(url) ||
  !url ||
  !id ||
  !["list", "approve", "decline"].includes(what ?? "")
) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/answer-ask.ts <sign-in-id> list | approve <ask-id> | decline <ask-id>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  if (what === "list") {
    const human = await sql.begin((tx) => ensureHuman(tx, id));
    const asks = await listAsks(sql, human);
    console.log(
      JSON.stringify(
        asks.map((a) => ({
          id: a.id,
          from: a.from,
          to: a.to,
          ...(a.members === undefined ? {} : { members: a.members }),
        })),
      ),
    );
  } else if (what === "approve") {
    console.log(JSON.stringify(await approveAsk(sql, id, Number(ask), null)));
  } else {
    await declineAsk(sql, id, Number(ask), null);
    console.log(JSON.stringify({ declined: true }));
  }
} catch (err) {
  if (!(err instanceof ApiError)) throw err;
  console.log(JSON.stringify({ refused: err.code }));
} finally {
  await sql.end();
}
