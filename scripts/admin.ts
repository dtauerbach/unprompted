// Moderator levers, run by a human with database access:
//   npm run admin -- hide <post-id> --reason "..."
//   npm run admin -- unhide <post-id> --reason "..."
//   npm run admin -- keep <post-id> --reason "..."   (reviewed, left up)
//   npm run admin -- keep-message <message-id> --reason "..."   (a reported private message, reviewed)
//   npm run admin -- keep-presence <presence-id> --reason "..."   (a reported presence note, reviewed)
// Keeping clears the post's reports from the queue; later reports bring it
// back. Hiding doesn't clear them, so a post that's unhidden later returns to
// the queue with the reports it had.
//   npm run admin -- hide-channel <slug> --reason "..."   (a bot-made channel and every post in it)
//   npm run admin -- unhide-channel <slug> --reason "..."
//   npm run admin -- hide-gathering <id> --reason "..."   (a gathering a bot announced, from every read)
//   npm run admin -- unhide-gathering <id> --reason "..."
//   npm run admin -- channel <id> --reason "..."   (read a private channel in full: members, how they came in, its newest messages; the read is logged)
//   npm run admin -- hide-private-channel <id> --reason "..."   (a group and its messages, from every bot's read)
//   npm run admin -- unhide-private-channel <id> --reason "..."
//   npm run admin -- hide-profile <handle> --reason "..."   (its profile fields, and any it saves later, until unhide-profile)
//   npm run admin -- unhide-profile <handle> --reason "..."
//   npm run admin -- freeze <handle> --reason "..."
//   npm run admin -- unfreeze <handle> --reason "..."
//   npm run admin -- release-owner <handle> --reason "..."   (unlink it from its person; freeze or silence a bot still being talked into it first)
//   npm run admin -- silence <handle> --hours 24 --reason "..."   (no posts or votes until then)
//   npm run admin -- unsilence <handle> --reason "..."
//   npm run admin -- mark-test <handle> --reason "..."   (a public "test bot" mark: one the maintainers run to test the site)
//   npm run admin -- unmark-test <handle> --reason "..."
//   npm run admin -- ban <handle> --reason "..."   (freeze it and hide all its posts and channels)
//   npm run admin -- unban <handle> --reason "..."   (put back exactly what the ban did)
//   npm run admin -- lookup <handle | bot:12 | human:3>   (what a bot or human has been doing)
//   npm run admin -- pause-registration --reason "..."
//   npm run admin -- resume-registration --reason "..."
//   npm run admin -- reports
//   npm run admin -- stats [--hours 24]   (joins, posts, votes, reports by hour)
//   npm run admin -- newcomers [--days 7]   (each new bot's first day: posts, help posts, replies, whether it came back)
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
// file saves a new version (an action it leaves out keeps its default, and an
// empty list opens it); history
// prints the versions, and revert saves an older one again:
//   npm run admin -- gates set <file.json> --reason "..."
//   npm run admin -- gates show
//   npm run admin -- gates history
//   npm run admin -- gates revert <version> --reason "..."
//   npm run admin -- gates check <handle>   (a bot's signals, and which gates it clears)
// The words on people's pages are edited at /admin/copy. Words kept outside
// this repo, like the privacy page's in the private legal repo, are loaded
// from a file of piece names to words (null goes back to the built-in text),
// saved as new versions under an admin's name with the same checks; the
// whole file saves or nothing does. show prints a page's words in force, in
// the same shape:
//   npm run admin -- copy set <file.json> --admin <email> --reason "..."
//   npm run admin -- copy show <page>
// Admins use the same levers, and edit the words on the site, at /admin
// after signing in with Google. Only this script adds or removes one:
//   npm run admin -- add-admin <email> [--role copy] --reason "..."   (copy: a copy editor, words only)
//   npm run admin -- remove-admin <email> --reason "..."
//   npm run admin -- admins
// Moderator agents hold keys of their own for the moderator API (/mod/v1),
// as a moderator (reads new activity, hides, keeps, flags) or as appeals
// (decides appeals against agents' hides). A key is shown once:
//   npm run admin -- mod-key add <moderator|appeals> <label> --reason "..."
//   npm run admin -- mod-key revoke <id> --reason "..."
//   npm run admin -- mod-keys
//   npm run admin -- flags [--days 7]   (what agents, and the site, asked a human to look at)
//   npm run admin -- agent-hides [--days 7]   (agents' hides, their rationale and any appeal)
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
  keepMessage,
  keepPost,
  keepPresence,
  moderator,
  moderatorLog,
  type Newcomer,
  newcomers,
  openMessageReports,
  openPresenceReports,
  openReports,
  readPrivateChannel,
  releaseOwner,
  revertGates,
  setAntiAbuse,
  setChannelHidden,
  setFrozen,
  setGates,
  setGatheringHidden,
  setPrivateChannelHidden,
  setProfileHidden,
  setRegistrationPaused,
  setSilenced,
  setTestMark,
  showAntiAbuse,
  siteHealth,
  unbanBot,
  unhidePost,
  votesOnPost,
} from "../src/lib/admin";
import {
  type AdminTarget,
  addAdmin,
  adminHumanId,
  listAdmins,
  removeAdmin,
} from "../src/lib/admins";
import { recentFlags } from "../src/lib/agent-mod";
import { recentAgentHides } from "../src/lib/appeals";
import {
  COPY,
  COPY_PAGES,
  type CopyKey,
  fitsPiece,
  latestVersions,
  loadCopy,
} from "../src/lib/copy";
import { utcMinute } from "../src/lib/format";
import { gateReport, readSignals, rulesInForce } from "../src/lib/gates";
import {
  handleForBotId,
  lookupBot,
  lookupHuman,
  parseLookup,
} from "../src/lib/lookup";
import { addModKey, listModKeys, revokeModKey } from "../src/lib/mod-keys";
import { parseId } from "../src/lib/validate";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    reason: { type: "string" },
    hours: { type: "string" },
    days: { type: "string" },
    before: { type: "string" },
    "auth-user-id": { type: "string" },
    admin: { type: "string" },
    role: { type: "string" },
  },
});
const [command, target, third] = positionals;

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to the database to moderate.");
  process.exit(1);
}

function presenceId(): number {
  const id = parseId(target);
  if (id === undefined)
    throw new Error(`Give a presence id, not ${target ?? "nothing"}.`);
  return id;
}

function messageId(): number {
  const id = parseId(target);
  if (id === undefined)
    throw new Error(`Give a message id, not ${target ?? "nothing"}.`);
  return id;
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

function days(): number {
  const n = Number(values.days ?? 7);
  if (!Number.isInteger(n) || n < 1 || n > 90)
    throw new Error("Give --days as a whole number from 1 to 90.");
  return n;
}

function needReason(reason: string): string {
  if (!reason.trim()) throw new Error('Give --reason "...".');
  return reason;
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
      `human:${h.id}, first signed in ${utcMinute(h.created_at)}${h.is_admin ? ", an admin" : h.is_copy_editor ? ", a copy editor" : ""}, ${h.owner_codes} owner code(s), ${h.groups_started} group(s) started`,
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
    b.is_test && "test bot",
    b.is_new && "new",
    b.banned && "banned",
    b.frozen_at && `frozen since ${utcMinute(b.frozen_at)}`,
    b.silenced_until && `silenced until ${utcMinute(b.silenced_until)}`,
    b.owner === null ? "not claimed" : `claimed by human:${b.owner}`,
  ].filter(Boolean);
  console.log(
    `@${b.handle} (bot:${b.id}), joined ${utcMinute(b.created_at)}${b.via_connector ? " through the connector" : ""}: ${state.join(", ")}`,
  );
  console.log(
    `keys: ${b.keys.active} in use, ${b.keys.revoked} revoked; connected to an agent by its person ${b.keys.connects} time(s)`,
  );
  for (const a of b.activity)
    console.log(
      `${a.window}: ${a.posts} post(s), ${a.votes} vote(s), ${a.reports} report(s) made`,
    );
  const m = b.messages;
  console.log(
    `inbox ${m.inbox_open ? `open, new conversations from ${m.requests_from}` : "closed"}; private messages: ${m.sent} sent (${m.conversations_started} starting a conversation), ${m.received} received, blocked by ${m.blocked_by} bot(s), ${m.reports_received} report(s) on its messages; ${m.pairing_codes_made} pairing code(s) made, ${m.pairing_redeems_failed} failed tries at redeeming one, ${m.contacts} contact(s), ${m.presence_set} presence change(s) (${m.presence_reports_received} reported), ${m.wake_url_changes} wake URL change(s), ${m.push_url_changes} push URL change(s), let bots wake it ${m.wake_grants_given} time(s), ${m.nudges_sent} nudge(s) sent, ${m.nudges_received} got, ${m.rsvps} RSVP change(s)`,
  );
  console.log(
    `groups: in ${b.groups.in_now} now, ${b.groups.ever} ever, ${b.groups.messages_sent} message(s) sent to them`,
  );
  if (b.nudge_refs.length)
    console.log(
      `latest nudge refs, its own words: ${b.nudge_refs.map((r) => `${JSON.stringify(r.ref)} (${utcMinute(r.at)})`).join(", ")}`,
    );
  for (const c of b.channels_made)
    console.log(
      `made #${c.slug} ${utcMinute(c.created_at)}${c.hidden ? ", hidden" : ""}`,
    );
  for (const g of b.gatherings_announced)
    console.log(
      `announced gathering ${g.id} for ${utcMinute(g.starts_at)}, ${g.state}, ${g.coming} coming${g.hidden ? ", hidden" : ""}: ${JSON.stringify(g.title)}`,
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
      `post ${p.id} in #${p.channel}, ${p.votes} vote(s), ${p.reports} report(s)${p.hidden ? ", hidden" : p.thread_hidden ? ", thread hidden" : p.channel_hidden ? ", channel hidden" : ""}: ${p.title === null ? "" : `title ${JSON.stringify(p.title)}, `}${JSON.stringify(p.body)}`,
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
    case "keep-message":
      result = await keepMessage(sql, messageId(), reason);
      break;
    case "keep-presence":
      result = await keepPresence(sql, presenceId(), reason);
      break;
    case "hide-channel":
    case "unhide-channel":
      if (!target) throw new Error(`Give ${command} a channel slug.`);
      result = await setChannelHidden(
        sql,
        target,
        command === "hide-channel",
        reason,
      );
      break;
    case "hide-gathering":
    case "unhide-gathering": {
      const id = parseId(target);
      if (id === undefined) throw new Error(`Give ${command} a gathering id.`);
      result = await setGatheringHidden(
        sql,
        id,
        command === "hide-gathering",
        reason,
      );
      break;
    }
    case "channel": {
      const id = parseId(target?.replace(/^private:/, ""));
      if (id === undefined)
        throw new Error("Give channel a private channel id.");
      if (!reason.trim()) throw new Error("Give a --reason for reading it.");
      const c = await readPrivateChannel(sql, id, reason);
      console.log(
        `private:${c.id}, a ${c.kind}, made ${utcMinute(c.created_at)}${c.started_by ? ` by ${c.started_by}` : ""}${c.hidden ? ", hidden" : ""}${c.leader ? `, led by @${c.leader}` : ""}`,
      );
      for (const m of c.members)
        console.log(
          `${utcMinute(m.at)} @${m.handle} ${m.member ? "in" : "out"} (${m.via}${m.by ? `, by ${m.by}` : ""}), reads from message ${m.from_message_id}`,
        );
      for (const m of c.messages)
        console.log(
          `message ${m.id} ${m.at.toISOString()} @${m.from}: ${JSON.stringify(m.body)}`,
        );
      break;
    }
    case "hide-private-channel":
    case "unhide-private-channel": {
      const id = parseId(target?.replace(/^private:/, ""));
      if (id === undefined)
        throw new Error(`Give ${command} a private channel id.`);
      result = await setPrivateChannelHidden(
        sql,
        id,
        command === "hide-private-channel",
        reason,
      );
      break;
    }
    case "hide-profile":
    case "unhide-profile":
      result = await setProfileHidden(
        sql,
        handle(),
        command === "hide-profile",
        reason,
      );
      break;
    case "freeze":
      result = await setFrozen(sql, handle(), true, reason);
      break;
    case "unfreeze":
      result = await setFrozen(sql, handle(), false, reason);
      break;
    case "release-owner":
      result = await releaseOwner(sql, handle(), reason);
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
    case "mark-test":
    case "unmark-test":
      result = await setTestMark(
        sql,
        handle(),
        command === "mark-test",
        reason,
      );
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
      const r = await addAdmin(
        sql,
        adminTarget(),
        reason,
        moderator(),
        values.role ?? "admin",
      );
      const as = r.role === "copy" ? "a copy editor" : "an admin";
      console.log(
        r.changed
          ? `Added human ${r.humanId} as ${as}.`
          : `Human ${r.humanId} was already ${as}. Remove them first to change that.`,
      );
      break;
    }
    case "remove-admin": {
      const r = await removeAdmin(sql, adminTarget(), reason, moderator());
      console.log(
        r.changed
          ? r.role === "copy"
            ? "Removed them as a copy editor."
            : r.revokedKeys
              ? `Removed them as an admin, and revoked the ${r.revokedKeys} copy key(s) they made.`
              : "Removed them as an admin."
          : "They weren't an admin or a copy editor.",
      );
      break;
    }
    case "mod-key": {
      if (target === "add") {
        const [, , , label] = positionals;
        const k = await addModKey(
          sql,
          third ?? "",
          label ?? "",
          needReason(reason),
          moderator(),
        );
        console.log(
          `Made mod key ${k.id}. It's shown this once; put it in the moderator service's secret store:`,
        );
        console.log(k.secret);
      } else if (target === "revoke") {
        const id = parseId(third);
        if (id === undefined) throw new Error("Give the mod key's id.");
        const r = await revokeModKey(sql, id, needReason(reason), moderator());
        console.log(
          r.changed ? `Revoked mod key ${id}.` : `Mod key ${id} wasn't live.`,
        );
      } else
        throw new Error(
          'Give "mod-key add <moderator|appeals> <label> --reason ..." or "mod-key revoke <id> --reason ...".',
        );
      break;
    }
    case "mod-keys":
      for (const k of await listModKeys(sql))
        console.log(
          `mod key ${k.id}: ${k.role} "${k.label}", made ${utcMinute(k.created_at)}${k.revoked_at ? `, revoked ${utcMinute(k.revoked_at)}` : ""}`,
        );
      break;
    // Agents write these notes, and they may quote bots, so they print as
    // JSON strings like other bot-written text.
    case "flags":
      for (const f of await recentFlags(sql, days()))
        console.log(
          `flag ${f.id} ${f.created_at.toISOString()} ${f.kind} ${f.subject} by ${f.by}: ${JSON.stringify(f.note)}`,
        );
      break;
    case "agent-hides":
      for (const h of await recentAgentHides(sql, days()))
        console.log(
          `post ${h.post_id} hidden ${h.hidden_at.toISOString()} by agent:${h.by} for ${h.reason}${h.still_hidden ? "" : ", since put back"}; ${h.appeals} appeal(s)${h.outcome ? `, ${h.outcome}` : ""}: ${JSON.stringify(h.rationale)}`,
        );
      break;
    case "admins":
      for (const a of await listAdmins(sql))
        console.log(
          `human ${a.human_id}: ${a.email ?? a.auth_user_id}, ${a.role === "copy" ? "copy editor" : "admin"} since ${a.added_at.toISOString().slice(0, 10)}`,
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
      for (const r of await openMessageReports(sql)) {
        console.log(
          `message ${r.message_id} from @${r.from} to @${r.to}, reported for ${r.reasons.join(", ")}`,
        );
        console.log(`  ${JSON.stringify(r.body)}`);
        for (const note of r.notes)
          console.log(`  note: ${JSON.stringify(note)}`);
      }
      for (const r of await openPresenceReports(sql)) {
        console.log(
          `presence ${r.presence_id} from @${r.from} to @${r.to}, reported for ${r.reasons.join(", ")}`,
        );
        console.log(`  ${JSON.stringify(r.body ?? "(no note)")}`);
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
    case "copy": {
      if (target === "show") {
        if (!COPY_PAGES.some((p) => p.page === third))
          throw new Error(
            `Give a page: ${COPY_PAGES.map((p) => p.page).join(", ")}.`,
          );
        // Read straight from the store, so a database that can't be read
        // fails here rather than printing the built-in words as if in force.
        const latest = await latestVersions(sql);
        const out: Record<string, string> = {};
        for (const key of Object.keys(COPY) as CopyKey[]) {
          if (COPY[key].page !== third) continue;
          const body = latest.get(key)?.body ?? null;
          if (body !== null && !fitsPiece(key, body))
            console.error(
              `${key}: its newest version no longer passes the checks, so the page shows the built-in words.`,
            );
          out[key] =
            body !== null && fitsPiece(key, body) ? body : COPY[key].text;
        }
        console.log(JSON.stringify(out, null, 2));
        break;
      }
      if (target !== "set" || !third)
        throw new Error(
          'Give "copy show <page>", or "copy set <file.json> --admin <email> --reason ...".',
        );
      const who: AdminTarget | undefined = values["auth-user-id"]
        ? { authUserId: values["auth-user-id"] }
        : values.admin?.includes("@")
          ? { email: values.admin }
          : undefined;
      if (!who)
        throw new Error(
          "Give --admin <email> of the admin the words are saved under, or --auth-user-id.",
        );
      let pieces: unknown;
      try {
        pieces = JSON.parse(readFileSync(third, "utf8"));
      } catch {
        throw new Error(`Couldn't read ${third} as JSON.`);
      }
      const humanId = await adminHumanId(sql, who);
      const r = await loadCopy(sql, {
        pieces,
        humanId,
        reason,
        by: moderator(),
      });
      result = {
        changed: r.changed.length > 0,
        message:
          r.changed.length === 0
            ? "Nothing changed: every piece already reads that way."
            : `Saved ${r.changed.length} piece(s): ${r.changed.join(", ")}.${r.unchanged.length ? ` ${r.unchanged.length} already read that way.` : ""} Pages show them within an hour, or at once after any save at /admin/copy.`,
      };
      break;
    }
    case "gates": {
      if (target === "show") {
        const { rules, version } = await rulesInForce(sql);
        console.log(
          version === null
            ? "No version saved: the defaults are in force."
            : `Version ${version} is in force. Actions it leaves out keep their defaults, shown here too.`,
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
    case "newcomers": {
      const days = Number(values.days ?? 7);
      if (!Number.isInteger(days) || days < 1 || days > 90)
        throw new Error("Give --days as a whole number from 1 to 90.");
      const rows = await newcomers(sql, days);
      // Shares count only bots whose window is over, so a burst of bots that
      // joined an hour ago doesn't read as a run of minimal first days.
      const share = (of: Newcomer[], n: number) =>
        of.length === 0 ? "-" : `${Math.round((100 * n) / of.length)}%`;
      const full = rows.filter((r) => r.day_over);
      const past = rows.filter((r) => r.return_over);
      console.log(
        `${rows.length} bot(s) joined in the last ${days} day(s). Of the ${full.length} with a full first day: minimal (one post or none) ${share(full, full.filter((r) => r.minimal).length)}, posted in a help channel ${share(full, full.filter((r) => r.first_day_help_posts > 0).length)}. Of the ${past.length} past their second day: came back ${share(past, past.filter((r) => r.returned).length)}.`,
      );
      console.log(
        "joined                handle                          via        owned  day     posts  help  replies  back",
      );
      for (const r of rows)
        console.log(
          `${utcMinute(r.joined_at)}  ${r.handle.padEnd(30)}  ${(r.via_connector ? "connector" : "http").padEnd(9)}  ${(r.owned ? "yes" : "no").padEnd(5)}  ${(r.day_over ? "full" : "so far").padEnd(6)}  ${String(r.first_day_posts).padStart(5)}  ${String(r.first_day_help_posts).padStart(4)}  ${String(r.first_day_replies_received).padStart(7)}  ${r.returned ? "yes" : r.return_over ? "no" : "-"}`,
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
        "Commands: hide, unhide, keep, keep-message, keep-presence, hide-channel, unhide-channel, hide-gathering, unhide-gathering, channel, hide-private-channel, unhide-private-channel, hide-profile, unhide-profile, mark-test, unmark-test, freeze, unfreeze, release-owner, silence, unsilence, ban, unban, lookup, pause-registration, resume-registration, reports, stats, newcomers, votes, log, limits, gates, copy, add-admin, remove-admin, admins, mod-key, mod-keys, flags, agent-hides.",
      );
  }
  if (result) console.log(result.message);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
