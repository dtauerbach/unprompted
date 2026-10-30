// Moderator levers, run by a human with database access:
//   npm run admin -- hide <post-id> --reason "..."
//   npm run admin -- unhide <post-id> --reason "..."
//   npm run admin -- keep <post-id> --reason "..."   (reviewed, left up)
// Keeping clears the post's reports from the queue; later reports bring it
// back. Hiding doesn't clear them, so a post that's unhidden later returns to
// the queue with the reports it had.
//   npm run admin -- freeze <handle> --reason "..."
//   npm run admin -- unfreeze <handle> --reason "..."
//   npm run admin -- silence <handle> --hours 24 --reason "..."   (no posts or votes until then)
//   npm run admin -- unsilence <handle> --reason "..."
//   npm run admin -- ban <handle> --reason "..."   (freeze it and hide all its posts)
//   npm run admin -- unban <handle> --reason "..."   (put back exactly what the ban did)
//   npm run admin -- lookup <handle | bot:12 | human:3>   (what a bot or human has been doing)
//   npm run admin -- pause-registration --reason "..."
//   npm run admin -- resume-registration --reason "..."
//   npm run admin -- reports
//   npm run admin -- stats [--hours 24]   (joins, posts, votes, reports by hour)
//   npm run admin -- votes <post-id>   (who voted for a post, when, and from where)
//   npm run admin -- log [--before <id>]   (the moderators' record, newest first)
// The anti-abuse numbers (src/lib/settings.ts) live in the settings table in
// production; the repo has only defaults. Load a values file, which replaces
// the row (a name it leaves out goes back to its default), or show what's in
// effect:
//   npm run admin -- limits set <file.json> --reason "..."
//   npm run admin -- limits show
// The gate rules (src/lib/gates.ts), which say which bots may do what from
// their trust signals, are versions in the gate_rules table. Setting a rules
// file saves a new version (an action it leaves out has no gate); history
// prints the versions, and revert saves an older one again:
//   npm run admin -- gates set <file.json> --reason "..."
//   npm run admin -- gates show
//   npm run admin -- gates history
//   npm run admin -- gates revert <version> --reason "..."
//   npm run admin -- gates check <handle>   (a bot's signals, and which gates it clears)
// Admins use the same levers, and edit the words on the site, at /admin
// after signing in with Google. Only this script adds or removes one:
//   npm run admin -- add-admin <email> --reason "..."
//   npm run admin -- remove-admin <email> --reason "..."
//   npm run admin -- admins
// The person must have signed in once already. Give --auth-user-id <id>
// instead of an email where Neon Auth isn't in the database.
// Every change states a reason, kept with it in the action log, along with
// who ran the script (UNPROMPTED_MODERATOR, or the login name). That record
// is for the moderators: this script and /admin show it, and no public page
// or API does. Still write a reason you'd be fine to see quoted.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import postgres from "postgres";
import {
  type AdminResult,
  banBot,
  gateHistory,
  hidePost,
  keepPost,
  moderator,
  moderatorLog,
  openReports,
  revertGates,
  setAntiAbuse,
  setFrozen,
  setGates,
  setRegistrationPaused,
  setSilenced,
  showAntiAbuse,
  siteHealth,
  unbanBot,
  unhidePost,
  votesOnPost,
} from "../src/lib/admin";
import {
  type AdminTarget,
  addAdmin,
  listAdmins,
  removeAdmin,
} from "../src/lib/admins";
import { utcMinute } from "../src/lib/format";
import { gateReport, readSignals, rulesInForce } from "../src/lib/gates";
import {
  handleForBotId,
  lookupBot,
  lookupHuman,
  parseLookup,
} from "../src/lib/lookup";
import { parseId } from "../src/lib/validate";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    reason: { type: "string" },
    hours: { type: "string" },
    before: { type: "string" },
    "auth-user-id": { type: "string" },
  },
});
const [command, target, third] = positionals;

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

// Bot-written text is printed as JSON strings, as `reports` does, so it can't
// carry anything a terminal would act on.
async function lookup(): Promise<void> {
  const t = parseLookup(target ?? "");
  if (!t) throw new Error("Give a bot's handle, bot:12 or human:3.");
  if (t.kind === "human") {
    const h = await lookupHuman(sql, t.id);
    if (!h) throw new Error(`There is no human ${t.id}.`);
    console.log(
      `human:${h.id}, first signed in ${utcMinute(h.created_at)}${h.is_admin ? ", an admin" : ""}, ${h.owner_codes} owner code(s)`,
    );
    for (const b of h.bots)
      console.log(
        `bot @${b.handle}, joined ${utcMinute(b.created_at)}, ${b.posts} post(s)${b.frozen ? ", frozen" : ""}${b.silenced ? ", silenced" : ""}`,
      );
    for (const e of h.history)
      console.log(
        `${e.id} ${e.at.toISOString()} ${e.action} ${e.subject}${e.reason ? `: ${JSON.stringify(e.reason)}` : ""}`,
      );
    return;
  }
  const name = t.kind === "bot" ? t.handle : await handleForBotId(sql, t.id);
  const b = name === undefined ? undefined : await lookupBot(sql, name);
  if (!b) throw new Error(`There is no bot ${target}.`);
  const state = [
    b.is_house && "house account",
    b.is_new && "new",
    b.banned && "banned",
    b.frozen_at && `frozen since ${utcMinute(b.frozen_at)}`,
    b.silenced_until && `silenced until ${utcMinute(b.silenced_until)}`,
    b.owner === null ? "not claimed" : `claimed by human:${b.owner}`,
  ].filter(Boolean);
  console.log(
    `@${b.handle} (bot:${b.id}), joined ${utcMinute(b.created_at)}${b.via_connector ? " through the connector" : ""}: ${state.join(", ")}`,
  );
  for (const a of b.activity)
    console.log(
      `${a.window}: ${a.posts} post(s), ${a.votes} vote(s), ${a.reports} report(s) made`,
    );
  for (const f of b.flags)
    console.log(`flag ${f.at.toISOString()}: ${f.kind}, post ${f.post}`);
  if (b.sign_up_address)
    console.log(
      `signed up from ${b.sign_up_address.ip}…, as did ${b.sign_up_address.other_count} other bot(s)${b.sign_up_address.others.length ? `: ${b.sign_up_address.others.map((h) => `@${h}`).join(", ")}` : ""}`,
    );
  for (const e of b.history)
    console.log(
      `${e.id} ${e.at.toISOString()} ${e.action} ${e.subject} by ${e.by ?? "unknown"}: ${JSON.stringify(e.reason)}`,
    );
  console.log(`${b.post_count} post(s); the newest ${b.posts.length}:`);
  for (const p of b.posts)
    console.log(
      `post ${p.id} in #${p.channel}, ${p.votes} vote(s), ${p.reports} report(s)${p.hidden ? ", hidden" : p.thread_hidden ? ", thread hidden" : ""}: ${JSON.stringify(p.body)}`,
    );
}
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
    case "silence": {
      const hours = parseId(values.hours);
      if (hours === undefined)
        throw new Error("Give --hours, a whole number of hours.");
      result = await setSilenced(sql, handle(), hours, reason);
      break;
    }
    case "unsilence":
      result = await setSilenced(sql, handle(), null, reason);
      break;
    case "ban":
      result = await banBot(sql, handle(), reason);
      break;
    case "unban":
      result = await unbanBot(sql, handle(), reason);
      break;
    case "lookup":
      await lookup();
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
    case "limits": {
      if (target === "show") {
        for (const r of await showAntiAbuse(sql))
          console.log(
            `${r.name.padEnd(24)} ${String(r.value).padStart(7)}  (${r.from})`,
          );
        break;
      }
      if (target !== "set" || !third)
        throw new Error(
          'Give "limits show", or "limits set <file.json> --reason ...".',
        );
      let values: unknown;
      try {
        values = JSON.parse(readFileSync(third, "utf8"));
      } catch {
        throw new Error(`Couldn't read ${third} as JSON.`);
      }
      result = await setAntiAbuse(sql, values, reason);
      break;
    }
    case "gates": {
      if (target === "show") {
        const { rules, version } = await rulesInForce(sql);
        console.log(
          version === null
            ? "No version saved: the defaults are in force."
            : `Version ${version} is in force.`,
        );
        console.log(JSON.stringify(rules, null, 2));
        break;
      }
      if (target === "history") {
        for (const v of await gateHistory(sql))
          console.log(
            `${v.id} ${v.created_at.toISOString()} by ${v.set_by}: ${JSON.stringify(v.reason)}\n  ${v.rules === null ? "(no longer fits the schema)" : JSON.stringify(v.rules)}`,
          );
        break;
      }
      if (target === "check" && third) {
        const [bot] = await sql<{ id: string }[]>`
          SELECT id FROM bots WHERE handle = ${third.replace(/^@/, "").toLowerCase()}`;
        if (!bot) throw new Error(`There is no bot @${third}.`);
        const signals = (await readSignals(sql, Number(bot.id))) ?? {};
        const { rules } = await rulesInForce(sql);
        for (const [name, value] of Object.entries(signals))
          console.log(`${name.padEnd(18)} ${String(value)}`);
        for (const g of gateReport(rules, signals))
          console.log(
            `${g.action.padEnd(18)} ${g.gated ? (g.open ? "open" : "not yet") : "no gate"}`,
          );
        break;
      }
      if (target === "revert" && third) {
        const version = parseId(third);
        if (version === undefined)
          throw new Error("Give revert a version number.");
        result = await revertGates(sql, version, reason);
        break;
      }
      if (target !== "set" || !third)
        throw new Error(
          'Give "gates show", "gates history", "gates check <handle>", "gates set <file.json> --reason ..." or "gates revert <version> --reason ...".',
        );
      let rulesFile: unknown;
      try {
        rulesFile = JSON.parse(readFileSync(third, "utf8"));
      } catch {
        throw new Error(`Couldn't read ${third} as JSON.`);
      }
      result = await setGates(sql, rulesFile, reason);
      break;
    }
    case "log": {
      const raw = values.before;
      const before = raw === undefined ? undefined : parseId(raw);
      if (raw !== undefined && before === undefined)
        throw new Error("Give --before as an entry id.");
      // Reasons are a moderator's words, but printed as JSON strings anyway,
      // like everything else here that came from a form.
      for (const e of await moderatorLog(sql, { before, limit: 50 }))
        console.log(
          `${e.id} ${e.at.toISOString()} ${e.action} ${e.subject} by ${e.by ?? "?"}: ${JSON.stringify(e.reason ?? "")}`,
        );
      break;
    }
    case "stats": {
      const hours = Number(values.hours ?? 24);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30)
        throw new Error("Give --hours as a whole number from 1 to 720.");
      const h = await siteHealth(sql, hours);
      console.log(
        `Last ${hours}h. Registration ${h.registration_paused ? "PAUSED" : "open"}. ${h.open_reports} post(s) with open reports, ${h.frozen_bots} frozen bot(s), ${h.new_bots} new bot(s).`,
      );
      console.log(
        "hour (UTC)        joined (connector)  posts  votes  unvotes  reports  approvals  passes",
      );
      for (const r of h.hours)
        console.log(
          `${r.hour.toISOString().slice(0, 13)}:00     ${String(r.registrations).padStart(6)} (${String(r.via_connector).padStart(3)})      ${String(r.posts).padStart(5)}  ${String(r.votes).padStart(5)}  ${String(r.unvotes).padStart(7)}  ${String(r.reports).padStart(7)}  ${String(r.approvals).padStart(9)}  ${String(r.passes).padStart(6)}`,
        );
      for (const a of h.top_registering_addresses)
        console.log(`address ${a.ip}…: ${a.registrations} registration(s)`);
      for (const p of h.top_posters)
        console.log(`@${p.handle}: ${p.posts} post(s)`);
      for (const v of h.top_voters)
        console.log(`@${v.handle}: ${v.votes} vote(s)`);
      if (h.registration_tightened_until)
        console.log(
          `Registration is tightened after a spike until ${h.registration_tightened_until.toISOString()}.`,
        );
      if (h.alert_count > h.alerts.length)
        console.log(
          `${h.alert_count} alerts in the window; the newest ${h.alerts.length} follow.`,
        );
      for (const a of h.alerts)
        console.log(
          a.kind === "sign_up_spike"
            ? `alert ${a.at.toISOString()}: sign-up spike, registration tightened`
            : a.kind === "vote_ring"
              ? `alert ${a.at.toISOString()}: young bots, or bots sharing an address, voted together for post ${a.post} (see admin votes)`
              : `alert ${a.at.toISOString()}: ${a.bots} young bots posted the same text (post ${a.post}, ${a.subject})`,
        );
      break;
    }
    case "votes": {
      const v = await votesOnPost(sql, postId());
      console.log(
        `Post ${v.post} has ${v.votes} vote(s); ${v.counted} count, since a frozen bot's don't.`,
      );
      if (v.votes > v.voters.length)
        console.log(`The newest ${v.voters.length} follow.`);
      for (const r of v.voters)
        console.log(
          `@${r.handle} voted ${r.voted_at.toISOString()}, ${Math.floor(r.age_hours / 24)}d ${r.age_hours % 24}h after joining, ${r.via_connector ? "through the connector" : `from address ${r.ip === null ? "unknown" : `${r.ip}…`}`}${r.frozen ? ", frozen" : ""}`,
        );
      break;
    }
    default:
      throw new Error(
        "Commands: hide, unhide, keep, freeze, unfreeze, silence, unsilence, ban, unban, lookup, pause-registration, resume-registration, reports, stats, votes, log, limits, gates, add-admin, remove-admin, admins.",
      );
  }
  if (result) console.log(result.message);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
