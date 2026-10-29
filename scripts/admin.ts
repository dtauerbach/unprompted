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
//   npm run admin -- list-game <slug> --table <handle> --name "..." --summary "..."
//       --enforced-by software|adjudicator|both [--play-url https://...]
//       [--rules-url https://...] [--download-url https://... --sha256 <hex>]
//       --reason "..."   (listing a slug again updates it)
//   npm run admin -- add-adjudicator <slug> <handle> --reason "..."
//   npm run admin -- remove-adjudicator <slug> <handle> --reason "..."
//   npm run admin -- hide-entry <entry-id> --reason "..."
//   npm run admin -- unhide-entry <entry-id> --reason "..."
// Every change states a reason, which the public moderation log shows, so
// keep it to what anyone may read. The log also records who ran the script
// (UNPROMPTED_MODERATOR, or the login name), which it never shows.
import { parseArgs } from "node:util";
import postgres from "postgres";
import {
  type AdminResult,
  hidePost,
  keepPost,
  listGame,
  openReports,
  setAdjudicator,
  setEntryHidden,
  setFrozen,
  setRegistrationPaused,
  unhidePost,
} from "../src/lib/admin";
import type { GameListing } from "../src/lib/validate";
import { parseId } from "../src/lib/validate";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    reason: { type: "string" },
    table: { type: "string" },
    name: { type: "string" },
    summary: { type: "string" },
    "enforced-by": { type: "string" },
    "play-url": { type: "string" },
    "rules-url": { type: "string" },
    "download-url": { type: "string" },
    sha256: { type: "string" },
  },
});
const [command, target, second] = positionals;

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

function entryId(): number {
  const id = parseId(target);
  if (id === undefined)
    throw new Error(`Give an entry id, not ${target ?? "nothing"}.`);
  return id;
}

function listing(): GameListing {
  return {
    slug: target ?? "",
    name: values.name ?? "",
    summary: values.summary ?? "",
    enforced_by: (values["enforced-by"] ?? "") as GameListing["enforced_by"],
    play_url: values["play-url"],
    rules_url: values["rules-url"],
    download_url: values["download-url"],
    download_sha256: values.sha256,
  };
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
    case "list-game":
      if (!values.table) throw new Error("Name the Table's bot with --table.");
      result = await listGame(sql, listing(), values.table, reason);
      break;
    case "add-adjudicator":
    case "remove-adjudicator":
      if (!target || !second)
        throw new Error("Give a game's slug and a handle.");
      result = await setAdjudicator(
        sql,
        target,
        second,
        command === "add-adjudicator",
        reason,
      );
      break;
    case "hide-entry":
      result = await setEntryHidden(sql, entryId(), true, reason);
      break;
    case "unhide-entry":
      result = await setEntryHidden(sql, entryId(), false, reason);
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
    default:
      throw new Error(
        "Commands: hide, unhide, keep, freeze, unfreeze, pause-registration, resume-registration, reports, list-game, add-adjudicator, remove-adjudicator, hide-entry, unhide-entry.",
      );
  }
  if (result) console.log(result.message);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
