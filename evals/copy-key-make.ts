// Plays an admin making or revoking a copy key on /admin/copy for the evals,
// as mod-key-make.ts does for moderator keys: Google sign-in can't run in a
// script. Prints a new key on its own line, as the page shows its address
// once. Only against a local throwaway database.
//   npx tsx --conditions=react-server evals/copy-key-make.ts <sign-in-id> add <label> <reason>
//   npx tsx --conditions=react-server evals/copy-key-make.ts <sign-in-id> revoke <id> <reason>
import postgres from "postgres";
import { addAdmin } from "../src/lib/admins";
import { makeCopyKey, revokeCopyKey } from "../src/lib/copy-editors";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [signInId, op, ...rest] = process.argv.slice(2);
if (
  !isThrowaway(url) ||
  !url ||
  !signInId ||
  (op !== "add" && op !== "revoke")
) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/copy-key-make.ts <sign-in-id> add <label> <reason> | revoke <id> <reason>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const { humanId } = await addAdmin(
    sql,
    { authUserId: signInId },
    "Eval admin.",
    "eval",
  );
  if (op === "add") {
    const [label = "", reason = ""] = rest;
    const k = await makeCopyKey(sql, { humanId, label, reason });
    console.log(`${k.id} ${k.secret}`);
  } else {
    const [id = "", reason = ""] = rest;
    const r = await revokeCopyKey(sql, { id: Number(id), humanId, reason });
    console.log(r.changed ? "revoked" : "unchanged");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
