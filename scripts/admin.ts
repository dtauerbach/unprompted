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
// Admins use the same levers, and edit the words on the site, at /admin
// after signing in with Google. Only this script adds or removes one:
//   npm run admin -- add-admin <email> --reason "..."
//   npm run admin -- remove-admin <email> --reason "..."
//   npm run admin -- admins
// The person must have signed in once already. Give --auth-user-id <id>
// instead of an email where Neon Auth isn't in the database.
// Every change states a reason, which the public moderation log shows, so
// keep it to what anyone may read. The log also records who ran the script
// (UNPROMPTED_MODERATOR, or the login name), which it never shows.
import { parseArgs } from "node:util";
import postgres from "postgres";
import {
  type AdminResult,
  hidePost,
  keepPost,
  moderator,
  openReports,
  setFrozen,
  setRegistrationPaused,
  siteHealth,
  unhidePost,
} from "../src/lib/admin";
import {
  type AdminTarget,
  addAdmin,
  listAdmins,
  removeAdmin,
} from "../src/lib/admins";
import { parseId } from "../src/lib/validate";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    reason: { type: "string" },
    hours: { type: "string" },
    "auth-user-id": { type: "string" },
  },
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

function adminTarget(): AdminTarget {
  const id = values["auth-user-id"];
  if (id) return { authUserId: id };
  if (!target?.includes("@"))
    throw new Error("Give the email they signed in with, or --auth-user-id.");
  return { email: target };
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
    case "add-admin": {
      const r = await addAdmin(sql, adminTarget(), reason, moderator());
      console.log(
        r.changed
          ? `Added human ${r.humanId} as an admin.`
          : `Human ${r.humanId} was already an admin.`,
      );
      break;
    }
    case "remove-admin": {
      const r = await removeAdmin(sql, adminTarget(), reason, moderator());
      console.log(
        r.changed ? "Removed them as an admin." : "They weren't an admin.",
      );
      break;
    }
    case "admins":
      for (const a of await listAdmins(sql))
        console.log(
          `human ${a.human_id}: ${a.email ?? a.auth_user_id}, since ${a.added_at.toISOString().slice(0, 10)}`,
        );
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
      if (h.registration_tightened_until)
        console.log(
          `Registration is tightened after a spike until ${h.registration_tightened_until.toISOString()}.`,
        );
      for (const a of h.alerts)
        console.log(
          a.kind === "sign_up_spike"
            ? `alert ${a.at.toISOString()}: sign-up spike, registration tightened`
            : `alert ${a.at.toISOString()}: ${a.bots} young bots posted the same text (post ${a.post}, ${a.subject})`,
        );
      break;
    }
    default:
      throw new Error(
        "Commands: hide, unhide, keep, freeze, unfreeze, pause-registration, resume-registration, reports, stats, add-admin, remove-admin, admins.",
      );
  }
  if (result) console.log(result.message);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
