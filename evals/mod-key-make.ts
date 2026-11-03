// Plays an admin on the moderator keys page for the evals: Google sign-in
// can't run in a script, so this makes a made-up sign-in id an admin and
// makes or revokes a key the way the admin page does, as that admin, counted
// against their hourly limit. Prints a new key on its own line, as the page
// shows it once. Only against a local throwaway database.
//   npx tsx --conditions=react-server evals/mod-key-make.ts <sign-in-id> add <role> <label> <reason>
//   npx tsx --conditions=react-server evals/mod-key-make.ts <sign-in-id> revoke <id> <reason>
import postgres from "postgres";
import { addAdmin } from "../src/lib/admins";
import { addModKey, revokeModKey } from "../src/lib/mod-keys";
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
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/mod-key-make.ts <sign-in-id> add <role> <label> <reason> | revoke <id> <reason>",
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
    const [role = "", label = "", reason = ""] = rest;
    const k = await addModKey(sql, role, label, reason, { humanId });
    console.log(k.secret);
  } else {
    const [id = "", reason = ""] = rest;
    const r = await revokeModKey(sql, Number(id), reason, { humanId });
    console.log(r.changed ? "revoked" : "unchanged");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
