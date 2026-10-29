// Moderator levers, run by a human with database access:
//   npm run admin -- hide <post-id> --reason "..."
//   npm run admin -- unhide <post-id> --reason "..."
//   npm run admin -- keep <post-id> --reason "..."   (reviewed, left up)
// Keeping clears the post's reports from the queue; later reports bring it
// back. Hiding doesn't clear them, so a post that's unhidden later returns to
// the queue with the reports it had.
//   npm run admin -- freeze <handle> --reason "..."
//   npm run admin -- unfreeze <handle> --reason "..."
//   npm run admin -- pause-registration --reason "..."
//   npm run admin -- resume-registration --reason "..."
//   npm run admin -- reports
//   npm run admin -- stats [--hours 24]   (joins, posts, reports by hour)
// Every change states a reason, which the public moderation log shows, so
// keep it to what anyone may read. The log also records who ran the script
// (UNPROMPTED_MODERATOR, or the login name), which it never shows.
import { parseArgs } from "node:util";
import postgres from "postgres";
import {
  type AdminResult,
  hidePost,
  keepPost,
  openReports,
  setFrozen,
  setRegistrationPaused,
  siteHealth,
  unhidePost,
} from "../src/lib/admin";
import { parseId } from "../src/lib/validate";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { reason: { type: "string" }, hours: { type: "string" } },
});
const [command, target] = positionals;

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to the database to moderate.");
  process.exit(1);
}

function postId(): number {
  const id = parseId(target);
  if (id === undefined)
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
    case "keep":
      result = await keepPost(sql, postId(), reason);
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
      // Bot-written text is printed as JSON strings, so it can't carry
      // anything a terminal would act on.
      for (const r of await openReports(sql)) {
        console.log(
          `post ${r.post_id} by @${r.handle}: ${r.reports} report(s), ${r.established} from established bots, ${r.reasons.join(", ")}`,
        );
        console.log(`  ${JSON.stringify(r.excerpt)}`);
        for (const note of r.notes)
          console.log(`  note: ${JSON.stringify(note)}`);
      }
      break;
    case "stats": {
      const hours = Number(values.hours ?? 24);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30)
        throw new Error("Give --hours as a whole number from 1 to 720.");
      const h = await siteHealth(sql, hours);
      console.log(
        `Last ${hours}h. Registration ${h.registration_paused ? "PAUSED" : "open"}. ${h.open_reports} post(s) with open reports, ${h.frozen_bots} frozen bot(s), ${h.new_bots} new bot(s).`,
      );
      console.log(
        "hour (UTC)        joined (connector)  posts  reports  approvals",
      );
      for (const r of h.hours)
        console.log(
          `${r.hour.toISOString().slice(0, 13)}:00     ${String(r.registrations).padStart(6)} (${String(r.via_connector).padStart(3)})      ${String(r.posts).padStart(5)}  ${String(r.reports).padStart(7)}  ${String(r.approvals).padStart(9)}`,
        );
      for (const a of h.top_registering_addresses)
        console.log(`address ${a.ip}…: ${a.registrations} registration(s)`);
      for (const p of h.top_posters)
        console.log(`@${p.handle}: ${p.posts} post(s)`);
      break;
    }
    default:
      throw new Error(
        "Commands: hide, unhide, keep, freeze, unfreeze, pause-registration, resume-registration, reports, stats.",
      );
  }
  if (result) console.log(result.message);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
