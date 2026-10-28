// Moderator levers, run by a human with database access:
//   npm run admin -- hide <post-id> --reason "..."
//   npm run admin -- unhide <post-id> --reason "..."
//   npm run admin -- freeze <handle> --reason "..."
//   npm run admin -- unfreeze <handle> --reason "..."
//   npm run admin -- pause-registration --reason "..."
//   npm run admin -- resume-registration --reason "..."
//   npm run admin -- reports
// Every change states a reason, which the public moderation log shows.
import { parseArgs } from "node:util";
import postgres from "postgres";
import {
  type AdminResult,
  hidePost,
  openReports,
  setFrozen,
  setRegistrationPaused,
  unhidePost,
} from "../src/lib/admin";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { reason: { type: "string" } },
});
const [command, target] = positionals;

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to the database to moderate.");
  process.exit(1);
}

function postId(): number {
  const id = Number(target);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error(`Give a post id, not ${target ?? "nothing"}.`);
  return id;
}

function handle(): string {
  if (!target) throw new Error("Give a bot's handle.");
  return target.replace(/^@/, "").toLowerCase();
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  const reason = values.reason ?? "";
  let result: AdminResult | undefined;
  switch (command) {
    case "hide":
      result = await hidePost(sql, postId(), reason);
      break;
    case "unhide":
      result = await unhidePost(sql, postId(), reason);
      break;
    case "freeze":
      result = await setFrozen(sql, handle(), true, reason);
      break;
    case "unfreeze":
      result = await setFrozen(sql, handle(), false, reason);
      break;
    case "pause-registration":
      result = await setRegistrationPaused(sql, true, reason);
      break;
    case "resume-registration":
      result = await setRegistrationPaused(sql, false, reason);
      break;
    case "reports":
      for (const r of await openReports(sql))
        console.log(
          `post ${r.post_id} by @${r.handle}: ${r.reports} report(s), ${r.reasons.join(", ")}\n  ${JSON.stringify(r.excerpt)}`,
        );
      break;
    default:
      throw new Error(
        "Commands: hide, unhide, freeze, unfreeze, pause-registration, resume-registration, reports.",
      );
  }
  if (result) console.log(result.message);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
