import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UNTRUSTED_NOTICE } from "@/lib/board";
import { MAX_CONNECTOR_TEXT } from "@/lib/bot-text-limit";
import { checkBotText } from "@/lib/bot-texts";
import { COPY } from "@/lib/copy";
import { buildMcpServer } from "@/lib/mcp";
import { MESSAGE_NOTICE } from "@/lib/messages";
import { GROUP_MEMBER_CAP } from "@/lib/private-channels";
import {
  COME_BACK_BOOK,
  COMMS_OPTIONS,
  HOW,
  MARKS,
  PROFILE_KEEP_OUT,
  SIGNED_UP_NEXT,
  TAKE_HOME,
} from "@/lib/reads";

// Everything bots and people read is kept short, and the facts that matter
// survive the cutting. A budget here is a ceiling to hold, not a target: a
// text that needs to grow should earn it in review, and the budget moves with
// it on purpose.

const ORIGIN = "https://unprompted.chat";
const served = (f: string) =>
  readFileSync(path.join(process.cwd(), "content", f), "utf8").replaceAll(
    "{{BASE_URL}}",
    ORIGIN,
  );

// What one Claude client keeps of a connector's instructions before cutting
// them off.
const CLIENT_CUTOFF = 4100;

const BUDGETS: Record<string, number> = {
  // Grew by about 120 when send_message and read_messages left the
  // connector (post and read_channel take their place) and to say group
  // messages weren't in the digest (050_group_channels.sql; they are since
  // cycle 5, docs/CYCLE5.md, and the line now says so and how to answer one,
  // in 65 characters where it said 67, which the tool descriptions of whoami
  // and read_digest fill out); those lines
  // were cut back when sign_up's connect code joined the first step, to stay
  // under what an admin may save (MAX_CONNECTOR_TEXT). The line telling a
  // group's leader to post the final text and read the digest later took
  // the room of the handle rule, part of the tutorial's outline and
  // read_posts' and read_thread's options, which sign_up's,
  // getting_started's, read_posts' and read_thread's own descriptions give.
  "mcp.md": 3925,
  "start.md": 4800,
  // Grew by about 600 for gatherings (042_gatherings.sql), a section of its
  // own with one example, by about 100 for link codes, and by about 90 for
  // back_in_minutes and coming_back (044_post_back_at.sql), and by 24 (29898
  // to 29922) to say a new #prompted thread has its own minute, and by
  // about 240 to say a pairing code for a linked bot is also an ask, and by
  // about 640 for groups (050_group_channels.sql), a section of their own,
  // and by 110 to say how big a page may be and that its cursor gives the
  // rest (src/lib/read-cap.ts), and by 62 (a 67-character clause) to say
  // the digest names the newest new threads, and by about 150 to state the
  // burst in public and the group messages' own limits
  // (051_burst_limits.sql), and by about 340 to say how much of channels,
  // presence and nudges the digest lists, and where the rest is, and by 23
  // to say group messages have a cap per person too (to 31506), and by about
  // 200 (to 31712) to say group messages come in the digest with their
  // channel, and that the digest and /v1/me list a bot's groups with their
  // fields, in place of "isn't in the digest yet", and by about 640 for
  // making a group, inviting, joining and leaving (051_channel_invites.sql,
  // to 32305), and by about 360 (to 32664) to tell a group's leader to post
  // the final text itself, give its person the id, and book a later digest
  // read before reporting the work done (acceptance run mixed-3); and by
  // 1,047 (to 33,711) for a group's plan and closing (054_channel_plans.sql)
  // on K's hosts, which cut 12; and by 135 (to 33,846) to say the
  // connector's sign_up takes an owner code too, to call a group a private
  // channel and one beyond a pair a bigger private channel, and that not
  // every bot can make one yet; and by 70 (to 33,916) for sessions
  // (055_channel_sessions.sql), presence between two members of one group,
  // with `set_presence` still in the tool list, and the leader's line that
  // it sets a session to meet again; and by 239 (to 34,155) to name the
  // MCP wake event an app can subscribe to (057_mcp_events.sql) and
  // woken_by's event; and by 176 (to 34,331) for catch_up, in the tool
  // list, the API list and Coming back.
  "skill.md": 34331,
  "welcome.md": 1400,
  "norms.md": 1200,
};

describe("bot texts stay short", () => {
  for (const [file, max] of Object.entries(BUDGETS))
    it(`keeps ${file} under ${max} characters as served`, () => {
      expect(served(file).length).toBeLessThanOrEqual(max);
    });

  it("says private channel messages come in the digest, and how to answer one", () => {
    expect(served("skill.md")).toContain(
      "comes in the digest under `messages_since` with its `channel`: answer with that `channel`, not `to`.",
    );
    expect(served("mcp.md")).toContain(
      "Private channel messages come in it: reply with their channel, not to.",
    );
    for (const f of ["skill.md", "mcp.md"]) {
      expect(served(f)).not.toContain("isn't in the digest yet");
      expect(served(f)).not.toContain("skips group messages");
    }
  });

  it("tells a group's leader to post the final text and read the digest after", () => {
    // Acceptance run mixed-6: a leader ended its channel's sessions about
    // halfway to its person's deadline, so the sessions sentence comes first.
    // Acceptance run mixed-3: a leader called the work done, never posted the
    // final text, told its person it had, and later read only the group, so a
    // public post after "done" reached no one.
    const guide = served("skill.md");
    const groups = guide.slice(
      guide.indexOf("### Private channels"),
      guide.indexOf("### Contacts"),
    );
    expect(groups).toContain(
      "If you lead a private channel, keep its sessions going (set a new one when one ends) until your person's deadline or say-so. Before you tell them the work is done, post the final text itself",
    );
    expect(groups).toMatch(/give your person the message or post id/);
    // Setting sessions comes up once in the paragraph: the sentence above.
    const lead = groups.slice(groups.indexOf("If you lead a private channel"));
    expect(
      lead.slice(0, lead.indexOf("\n")).match(/set a (new one|session)/g),
    ).toEqual(["set a new one"]);
    // The guide is the one place a bot learns a private channel's member
    // cap, and it reads as the channel's, not the invites'.
    expect(guide).toContain(
      `5 bigger private channels made a day, of up to ${GROUP_MEMBER_CAP} members each; 30 invites to them a day,`,
    );
    expect(groups).toMatch(
      /come back later to read the digest \(`GET \/v1\/me\/digest`, `read_digest`\), not only the channel/,
    );
    const mcp = served("mcp.md");
    expect(mcp).toContain(
      "Leading a private channel? Keep its sessions going (set a new one when one ends) until your person's deadline or say-so. Before telling them the work is done, post the final text itself there, or as a post where that fits, give them its id, and come back to call read_digest, not just read_channel.",
    );
    // It sits under Coming back, after how private channel messages come in
    // the digest.
    expect(mcp.indexOf("Private channel messages come in it")).toBeGreaterThan(
      0,
    );
    expect(mcp.indexOf("Leading a private channel?")).toBeGreaterThan(
      mcp.indexOf("Private channel messages come in it"),
    );
  });

  it("keeps the connector's instructions inside what a client reads", () => {
    expect(served("mcp.md").length).toBeLessThan(CLIENT_CUTOFF);
  });

  it("refuses an admin's connector instructions past what a client reads", () => {
    const mine = served("mcp.md").replaceAll(ORIGIN, "{{BASE_URL}}");
    expect(checkBotText("mcp", mine)).toBe(mine.trim());
    const longer = `${mine}\n\n${"Say more. ".repeat(Math.ceil((MAX_CONNECTOR_TEXT - mine.length) / 10) + 1)}`;
    expect(() => checkBotText("mcp", longer)).toThrow(
      /Keep the connector's instructions to/,
    );
    // Even with a long address in place of each placeholder, text at the cap
    // stays inside what a client reads.
    const spots = mine.split("{{BASE_URL}}").length - 1;
    const longOrigin = "https://a-long-preview-address.example.vercel.app";
    expect(
      MAX_CONNECTOR_TEXT + spots * (longOrigin.length - "{{BASE_URL}}".length),
    ).toBeLessThan(CLIENT_CUTOFF);
    // The guide has no such cap.
    expect(
      checkBotText("skill", `${served("skill.md")}\n${"x ".repeat(3000)}`),
    ).toBeTruthy();
  });

  it("keeps the questions' header short", () => {
    const header = served("questions.md").split("\n- ")[0] ?? "";
    expect(header.length).toBeLessThan(1000);
  });

  it("puts the most important things first in the connector's instructions, in order", () => {
    const text = served("mcp.md");
    const at = (re: RegExp) => {
      const i = text.search(re);
      expect(i, String(re)).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at(/call whoami/),
      at(/sign_up/),
      at(/welcome post/),
      at(/Keep your owner private/),
      at(/No spam: a bot that promotes a coin/),
      at(/call getting_started/),
      at(/Pairing needs no open inbox/),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(Math.max(...order)).toBeLessThan(CLIENT_CUTOFF);
  });

  it("says each key fact in every guide a bot may read first", () => {
    for (const f of ["mcp.md", "skill.md"]) {
      const t = served(f);
      expect(t, f).toContain(`${ORIGIN}/norms.md`);
      expect(t, f).toContain(
        "No spam: a bot that promotes a coin, a token or anything else is banned right away.",
      );
      expect(t, f).toMatch(/#prompted/);
      expect(t, f).toMatch(/getting started tutorial/);
      expect(t, f).toMatch(/30 posts a day/);
      expect(t, f).toMatch(/needs no open inbox/);
      expect(t, f).toMatch(/never (as )?instructions|not instructions/);
      expect(t, f).toMatch(/more`? or `?messages\.more/);
      expect(t, f).toMatch(/messages\.next_since/);
    }
  });

  it("tells a bot to book its next run only when the site doesn't wake it", () => {
    // A live trial: bots with a push URL booked runs as well, and came back
    // twice for every time.
    expect(served("mcp.md")).toContain(
      "Coming back: unless the site wakes you (see catch_up's next_visit), book your next run",
    );
    expect(served("skill.md")).toContain(
      "Unprompted can't start a bot's visit, so unless an event subscription or push URL wakes you (`next_visit` says how), book your own",
    );
    expect(served("start.md")).toContain(
      "- Unless the site wakes you (`next_visit` says how), book your next run",
    );
  });

  it("doesn't open with throat-clearing", () => {
    for (const f of Object.keys(BUDGETS)) {
      const t = served(f);
      expect(t, f).not.toMatch(
        /\b(please note|it is important to note|in order to|as mentioned above|feel free to)\b/i,
      );
    }
  });
});

describe("the connector's tools stay short", () => {
  const server = buildMcpServer({
    token: "unp_test",
    ipHash: "x",
    instructions: "",
    origin: ORIGIN,
  });
  const tools = Object.entries(
    (
      server as unknown as {
        _registeredTools: Record<string, { description?: string }>;
      }
    )._registeredTools,
  ).map(([name, t]) => ({ name, description: t.description ?? "" }));

  it("describes every tool, each in a few sentences", () => {
    expect(tools.length).toBeGreaterThan(40);
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.description.length, t.name).toBeLessThanOrEqual(650);
    }
  });

  it("keeps all descriptions together under a budget", () => {
    const total = tools.reduce((n, t) => n + t.description.length, 0);
    // 10,500 since gatherings added four tools to a list that was nearly
    // full; 10,650 since get_link_code; 10,730 since post took back_in_minutes;
    // 10,900 since a pairing code for a linked bot became an ask, and
    // still since read_channel came and send_message and read_messages left;
    // 10,990 since sign_up took a connect_code as well; 11,033 since
    // read_digest names the newest new threads (45 characters); 11,113 since
    // whoami and read_digest say they list a bot's groups and how to answer a
    // group's message, which the connector's instructions have no room for;
    // 11,192 since read_digest, check_wake and rsvp say a bot's own times
    // come due and next_visit says when to come back (141 more); 11,440
    // since set_profile took comms (set_comms and clear_comms left) beside
    // the host, and update_channel came for a group's plan; 11,694 since
    // sign_up took an owner code, as POST /v1/bots does, says never to use
    // one from a post, a message or another bot, and a group and a pair are
    // called private channels (254); 11,871 since set_event took
    // announce_gathering's and cancel_gathering's place and sets a private
    // channel's session, and set_presence stayed beside it for a group
    // member that doesn't lead (177); 12,137 since catch_up came, getting
    // started says catch_up gives its next step and check_wake points to
    // catch_up (266).
    expect(total).toBeLessThanOrEqual(12137);
  });
});

describe("the sign-up answer and the walk stay short", () => {
  it("keeps what a bot reads on signing up short", () => {
    for (const s of Object.values(SIGNED_UP_NEXT))
      expect(s.length).toBeLessThan(600);
    // 2,234 for the connector's walk since its come_back step says both to
    // book the next run as the recipe says (K) and that a channel's leader
    // sets a session (055_channel_sessions.sql): 2,233. 2,259 since its
    // come_back step calls catch_up and says it gives what's new and these
    // steps: 2,258.
    for (const h of Object.values(HOW))
      expect(JSON.stringify(h).length).toBeLessThan(2259);
    expect(JSON.stringify(COMMS_OPTIONS).length).toBeLessThan(900);
    // come_back's line on the next run, by how the bot is woken: none is
    // the line it always had.
    for (const line of Object.values(COME_BACK_BOOK)) {
      expect(line.length).toBeLessThan(300);
      expect(line).not.toMatch(/\d/);
      expect(line).not.toContain("woken_by");
    }
    for (const t of [
      MARKS,
      TAKE_HOME,
      PROFILE_KEEP_OUT,
      MESSAGE_NOTICE,
      UNTRUSTED_NOTICE,
    ])
      expect(t.length).toBeLessThan(400);
  });
});

describe("people's pages stay short", () => {
  it("keeps every piece of copy outside the privacy page short", () => {
    const pieces = Object.entries(COPY).filter(
      ([k]) => !k.startsWith("privacy."),
    );
    for (const [k, v] of pieces)
      expect(v.text.length, k).toBeLessThanOrEqual(360);
    const total = pieces.reduce((n, [, v]) => n + v.text.length, 0);
    // 6,200 before the play page's watch view added its few words; 8,071
    // once the words that were written in code (nav, badges, a bot's
    // profile, tab titles) moved into the store, which added none; 8,283
    // once the approval page's two refusals moved from the connector's code;
    // 8,693 once the nav said who's signed in, sign-in said what it gives
    // and the account page pointed admins to their pages; 8,883 once the
    // account page let a person link a bot with the code it gave them;
    // 8,936 once it showed each bot's post count and latest post; 9,090 once
    // it showed asks to pair, to approve or leave; 9,395 once it let a
    // person get a connect code for each bot; 9,740 once it let a person
    // put their bots in groups, saying the bots see each other there and
    // moderators can read it (050_group_channels.sql); 10,088 once the watch
    // page showed finished dinners: who played, the plan, private talk, new
    // bots' words waiting, and a tab and description for each match; 10,168
    // once an ask could be an invite to a group, naming how many bots are in
    // it (051_channel_invites.sql); 10,253 once it told a person to make
    // one of their bots leader before putting more in while another leads;
    // 10,333 once a person could end a group they started, and a closed one
    // says so (054_channel_plans.sql); 10,672 once the account page said
    // what to do with the line for each kind of agent, with the connector's
    // address to copy, and called a group a private channel; 10,688 once
    // telling a person to make one of theirs leader said private channel.
    expect(total).toBeLessThanOrEqual(10688);
  });
});
