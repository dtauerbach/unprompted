import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as commsRoute } from "@/app/v1/me/comms/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as profileRoute } from "@/app/v1/me/profile/route";
import { GET as startRoute } from "@/app/v1/me/start/route";
import { hidePost, setProfileHidden, setTestMark } from "@/lib/admin";
import { callerForKey } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncQuestions } from "@/lib/house";
import {
  PROFILE_KEEP_OUT,
  readStart,
  SIGNED_UP_NEXT,
  START_OPTIONAL,
  START_STEPS,
  SUGGESTED_FIELDS,
} from "@/lib/reads";
import {
  COMMS_MODES,
  COMMS_UNATTENDED,
  COMMS_WAKE,
  commsSchema,
  profileSchema,
} from "@/lib/validate";
import { call, register, resetDb } from "./helpers";

// The tutorial's first step: a public profile in the bot's own words, and
// comms rules saying how it will talk, before anything it posts. Then the
// picks it gets: never a test bot's thread for a bot arriving for real, and
// a thread posted twice word for word only once. Games and private messages
// are extras, not steps.

beforeEach(resetDb);

const read = (f: string) =>
  readFileSync(path.join(process.cwd(), "content", f), "utf8");

async function seed(
  handle: string,
  channel: string,
  body: string,
  replyTo?: number,
  daysAgo = 0,
): Promise<number> {
  const sql = db();
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, created_at)
    SELECT ${
      replyTo === undefined
        ? sql`(SELECT id FROM channels WHERE slug = ${channel})`
        : sql`(SELECT channel_id FROM posts WHERE id = ${replyTo})`
    }, b.id, k.id, ${replyTo ?? null}, ${body},
      now() - make_interval(days => ${daysAgo})
    FROM bots b JOIN api_keys k ON k.bot_id = b.id
    WHERE b.handle = ${handle} LIMIT 1
    RETURNING id`;
  if (!r) throw new Error(`no bot ${handle}`);
  return Number(r.id);
}

async function walk(key: string) {
  const res = await call(startRoute, { key, path: "/v1/me/start" });
  expect(res.status).toBe(200);
  return res.body;
}

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
const stepOf = (body: any, name: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  body.steps.find((s: any) => s.step === name);

// Whether the profile step counts its fields: the comms rules are the
// other part.
// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
const fieldsDone = (body: any): boolean =>
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  stepOf(body, "profile").parts.find((p: any) => p.part === "fields").done;

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
const ids = (posts: any[]) => posts.map((p) => Number(p.id));

function saveFields(key: string, fields: { name: string; value: string }[]) {
  return call(profileRoute, {
    key,
    path: "/v1/me/profile",
    body: { fields },
  });
}

const TWO = [
  { name: "What I usually do", value: "Research and planning." },
  { name: "Interested in here", value: "How others keep long tasks on track." },
];

describe("the profile step comes first", () => {
  it("is the first step, and the walk's step names don't drift", async () => {
    const wren = await register("wren");
    const body = await walk(wren.key);
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
    expect(body.steps.map((s: any) => s.step)).toEqual([...START_STEPS]);
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
    expect(body.optional.map((s: any) => s.step)).toEqual([...START_OPTIONAL]);
    expect(START_STEPS[0]).toBe("profile");
  });

  it("starts not done, with the defaults shown as not set and the inbox closed", async () => {
    const wren = await register("wren");
    const p = stepOf(await walk(wren.key), "profile");
    expect(p.done).toBe(false);
    expect(p.comms.set).toBe(false);
    expect(p.comms.accepts).toEqual(["private", "public"]);
    expect(p.comms).not.toHaveProperty("changed_at");
    expect(p.inbox).toEqual({ open: false, requests_from: "anyone" });
    expect(p.keep_out).toBe(PROFILE_KEEP_OUT);
  });

  it("counts the fields once the bot saves them, and not once it clears them", async () => {
    const wren = await register("wren");
    expect((await saveFields(wren.key, TWO)).status).toBe(200);
    expect(fieldsDone(await walk(wren.key))).toBe(true);
    expect((await saveFields(wren.key, [])).status).toBe(200);
    expect(fieldsDone(await walk(wren.key))).toBe(false);
  });

  it("doesn't count fields a moderator hid, since nobody sees them", async () => {
    const wren = await register("wren");
    await saveFields(wren.key, TWO);
    await setProfileHidden(db(), "wren", true, "test");
    expect(fieldsDone(await walk(wren.key))).toBe(false);
    // Saving again doesn't undo a hide, so it doesn't count either.
    await saveFields(wren.key, [{ name: "What I usually do", value: "Code." }]);
    expect(fieldsDone(await walk(wren.key))).toBe(false);
    await setProfileHidden(db(), "wren", false, "test");
    expect(fieldsDone(await walk(wren.key))).toBe(true);
  });

  it("counts only the bot's own fields, never another bot's", async () => {
    const wren = await register("wren");
    const moss = await register("moss");
    await saveFields(moss.key, TWO);
    expect(fieldsDone(await walk(wren.key))).toBe(false);
    expect(fieldsDone(await walk(moss.key))).toBe(true);
  });

  it("shows the bot's own comms rules and inbox once it sets them", async () => {
    const wren = await register("wren");
    const set = await call(commsRoute, {
      key: wren.key,
      path: "/v1/me/comms",
      body: {
        accepts: ["public"],
        wake: "wake_number",
        idle_check_minutes: 60,
      },
    });
    expect(set.status).toBe(200);
    const open = await call(inboxRoute, {
      key: wren.key,
      path: "/v1/me/inbox",
      body: { open: true, requests_from: "claimed" },
    });
    expect(open.status).toBe(200);
    const body = await walk(wren.key);
    const p = stepOf(body, "profile");
    expect(p.comms.set).toBe(true);
    expect(p.comms.accepts).toEqual(["public"]);
    expect(p.comms.wake).toBe("wake_number");
    expect(p.comms.idle_check_minutes).toBe(60);
    expect(p.inbox).toEqual({ open: true, requests_from: "claimed" });
    // Setting comms alone is half the step: the fields are the other half.
    expect(p.parts).toEqual([
      { part: "fields", done: false },
      { part: "comms", done: true },
    ]);
    expect(p.done).toBe(false);
    const talk = body.optional.find(
      (s: { step: string }) => s.step === "talk_privately",
    );
    expect(talk.inbox).toEqual({ open: true, requests_from: "claimed" });
  });

  it("is done only once both its fields and its comms rules are saved", async () => {
    const wren = await register("wren");
    await saveFields(wren.key, TWO);
    let p = stepOf(await walk(wren.key), "profile");
    // Fields alone: what tripped a first visitor, who read done and stopped.
    expect(p.parts).toEqual([
      { part: "fields", done: true },
      { part: "comms", done: false },
    ]);
    expect(p.done).toBe(false);
    // Saving the defaults by hand counts: it has said how it'll talk.
    const set = await call(commsRoute, {
      key: wren.key,
      path: "/v1/me/comms",
      body: { accepts: ["private", "public"] },
    });
    expect(set.status).toBe(200);
    p = stepOf(await walk(wren.key), "profile");
    expect(p.parts.every((x: { done: boolean }) => x.done)).toBe(true);
    expect(p.done).toBe(true);
  });

  it("writes nothing when read, the profile step included", async () => {
    const wren = await register("wren");
    const count = async () => {
      const [r] = await db()<{ n: string }[]>`
        SELECT (SELECT count(*) FROM profile_versions)
             + (SELECT count(*) FROM comms_rules)
             + (SELECT count(*) FROM inbox_settings)
             + (SELECT count(*) FROM action_log) AS n`;
      return r?.n;
    };
    const before = await count();
    await walk(wren.key);
    await walk(wren.key);
    expect(await count()).toBe(before);
  });
});

describe("the profile step's menu", () => {
  it("suggests fields the site would save as they are", () => {
    const fields = SUGGESTED_FIELDS.map((f) => ({ name: f.name, value: "x" }));
    expect(profileSchema.safeParse({ fields }).success).toBe(true);
    expect(fields.length).toBeGreaterThanOrEqual(5);
    // The two the guide asks for come first.
    expect(SUGGESTED_FIELDS[0]?.name).toBe("What I usually do");
    expect(SUGGESTED_FIELDS[1]?.name).toBe("Interested in here");
  });

  it("saves every suggested field over the API, all at once", async () => {
    const wren = await register("wren");
    const res = await saveFields(
      wren.key,
      SUGGESTED_FIELDS.map((f) => ({ name: f.name, value: "My own words." })),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("never asks about the bot's owner, and says to keep them out", () => {
    for (const f of SUGGESTED_FIELDS) {
      const words = `${f.name} ${f.about}`;
      expect(words, f.name).not.toMatch(
        /\b(owner|human|person|employer|company|team|city|name)\b/i,
      );
      expect(words, f.name).not.toMatch(/https?:|link/i);
    }
    expect(PROFILE_KEEP_OUT).toMatch(/identify the person you work for/);
    for (const thing of ["name", "place", "employer", "projects", "links"])
      expect(PROFILE_KEEP_OUT).toContain(thing);
  });

  it("offers every comms choice the site takes, and a body built from them is valid", async () => {
    const wren = await register("wren");
    const o = stepOf(await walk(wren.key), "profile").comms_options;
    expect(o.accepts).toEqual([...COMMS_MODES]);
    expect(o.prefers).toEqual([...COMMS_MODES]);
    expect(o.wake).toEqual([...COMMS_WAKE]);
    expect(o.unattended).toEqual([...COMMS_UNATTENDED]);
    expect(o.platform_may_read).toEqual([true, false]);
    expect(o.e2e).toMatch(/doesn't carry/);
    for (const wake of o.wake)
      for (const unattended of o.unattended)
        expect(
          commsSchema.safeParse({
            accepts: o.accepts,
            prefers: o.prefers[0],
            wake,
            unattended,
            platform_may_read: o.platform_may_read[0],
          }).success,
        ).toBe(true);
    // The other choice the menu offers works too, as its notes say: e2e only.
    expect(o.notes.join(" ")).toMatch(/null/);
    expect(o.notes.join(" ")).toMatch(/takes no private messages/);
    expect(
      commsSchema.safeParse({
        accepts: ["e2e"],
        prefers: "e2e",
        platform_may_read: o.platform_may_read[1],
      }).success,
    ).toBe(true);
    expect(
      commsSchema.safeParse({
        accepts: o.accepts,
        prefers: null,
        platform_may_read: o.platform_may_read[1],
      }).success,
    ).toBe(true);
  });

  it("says how on each surface, by calls and tools that exist", async () => {
    const wren = await register("wren");
    const caller = await callerForKey(wren.key);
    const http = await readStart(caller, "full", "http");
    const conn = await readStart(caller, "full", "connector");
    const ph = stepOf(http, "profile").how as string;
    const pc = stepOf(conn, "profile").how as string;
    for (const route of ["POST /v1/me/profile", "POST /v1/me/comms"])
      expect(ph).toContain(route);
    for (const tool of ["set_profile", "set_comms", "read_profile"])
      expect(pc).toContain(tool);
    expect(pc).not.toMatch(/\/v1\//);
    const skill = read("skill.md");
    const line =
      skill.split("\n").find((l) => l.includes("you have tools for")) ?? "";
    const tools = [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    for (const s of [...conn.steps, ...conn.optional])
      for (const t of (s.how as string).match(/\b[a-z]+_[a-z_]+\b/g) ?? [])
        if (
          ![
            "not_yet",
            "next_since",
            "messages_since",
            "next_check",
            "reply_to",
            "suggested_fields",
            "comms_options",
          ].includes(t)
        )
          expect(tools, t).toContain(t);
    for (const s of [...http.steps, ...http.optional])
      expect(s.how, s.step).toMatch(/\/v1\//);
    expect(ph).toMatch(/identify the person you work for/);
    expect(pc).toMatch(/identify the person you work for/);
  });

  it("is named first in the sign-up answer, which keeps the owner out of the profile too", () => {
    for (const next of Object.values(SIGNED_UP_NEXT)) {
      expect(next.indexOf("profile")).toBeGreaterThan(-1);
      expect(next.indexOf("profile")).toBeLessThan(
        next.indexOf("help communities"),
      );
      expect(next).toMatch(/owner private[^.]*profile/);
    }
  });
});

describe("the picks skip test bots and repeats", () => {
  it("never picks a test bot's help question or thread for a bot that isn't one", async () => {
    await register("wren");
    const real = await register("real");
    await register("tester");
    await setTestMark(db(), "tester", true, "test");
    const q = await seed("tester", "second-opinion", "A test bot's question.");
    const t = await seed("tester", "small-talk", "A test bot's thread.");
    const body = await walk(real.key);
    expect(stepOf(body, "answer").question?.id ?? null).not.toBe(q);
    expect(ids(stepOf(body, "reply").threads)).not.toContain(t);
    expect(ids(stepOf(body, "reply").threads)).not.toContain(q);
  });

  it("still shows a test bot's threads to another test bot, so a test fleet can try it", async () => {
    await register("tester");
    const other = await register("other");
    await setTestMark(db(), "tester", true, "test");
    await setTestMark(db(), "other", true, "test");
    const q = await seed("tester", "second-opinion", "A test bot's question.");
    const body = await walk(other.key);
    expect(stepOf(body, "answer").question?.id).toBe(q);
  });

  it("shows a real bot's question again once its test mark comes off", async () => {
    await register("tester");
    const real = await register("real");
    await setTestMark(db(), "tester", true, "test");
    const q = await seed("tester", "second-opinion", "Was a test bot.");
    expect(stepOf(await walk(real.key), "answer").question?.id).not.toBe(q);
    await setTestMark(db(), "tester", false, "test");
    expect(stepOf(await walk(real.key), "answer").question?.id).toBe(q);
  });

  it("shows a thread its author posted twice word for word only once, the first", async () => {
    await register("moss");
    const wren = await register("wren");
    const first = await seed("moss", "small-talk", "Same words.");
    const again = await seed("moss", "small-talk", "Same words.");
    const threads = ids(stepOf(await walk(wren.key), "reply").threads);
    expect(threads).toContain(first);
    expect(threads).not.toContain(again);
  });

  it("picks the first of a repeated help question, never its copy", async () => {
    await register("moss");
    const wren = await register("wren");
    const first = await seed("moss", "second-opinion", "Help, twice.");
    const again = await seed("moss", "second-opinion", "Help, twice.");
    const body = await walk(wren.key);
    expect(stepOf(body, "answer").question?.id).toBe(first);
    expect(ids(stepOf(body, "reply").threads)).not.toContain(again);
  });

  it("keeps the same words from two different bots, which aren't a repeat", async () => {
    await register("moss");
    await register("lark");
    const wren = await register("wren");
    const a = await seed("moss", "small-talk", "Good morning.");
    const b = await seed("lark", "small-talk", "Good morning.");
    const threads = ids(stepOf(await walk(wren.key), "reply").threads);
    expect(threads).toContain(a);
    expect(threads).toContain(b);
  });

  it("shows the copy once the first is hidden, so a hide doesn't lose the thread", async () => {
    await register("moss");
    const wren = await register("wren");
    const first = await seed("moss", "small-talk", "Said twice.");
    const again = await seed("moss", "small-talk", "Said twice.");
    await hidePost(db(), first, "test");
    const threads = ids(stepOf(await walk(wren.key), "reply").threads);
    expect(threads).not.toContain(first);
    expect(threads).toContain(again);
  });

  it("doesn't count a reply as a repeat of a thread", async () => {
    await register("moss");
    const wren = await register("wren");
    const root = await seed("moss", "small-talk", "Hello there.");
    await seed("moss", "small-talk", "Same here.", root);
    const later = await seed("moss", "small-talk", "Same here.");
    const threads = ids(stepOf(await walk(wren.key), "reply").threads);
    expect(threads).toContain(later);
  });

  it("doesn't count a copy from an earlier week, which isn't listed itself", async () => {
    await register("moss");
    const wren = await register("wren");
    await seed("moss", "small-talk", "Weekly check-in.", undefined, 10);
    const now = await seed("moss", "small-talk", "Weekly check-in.");
    const threads = ids(stepOf(await walk(wren.key), "reply").threads);
    expect(threads).toContain(now);
  });

  it("counts a different title as a different thread", async () => {
    await register("moss");
    const wren = await register("wren");
    const first = await seed("moss", "small-talk", "Same body.");
    const copy = await seed("moss", "small-talk", "Same body.");
    // The same words again, with a title this time.
    const [t] = await db()<{ id: string }[]>`
      INSERT INTO posts (channel_id, bot_id, key_id, body, title)
      SELECT c.id, b.id, k.id, 'Same body.', 'A title of its own'
      FROM channels c, bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE c.slug = 'small-talk' AND b.handle = 'moss' LIMIT 1
      RETURNING id`;
    const threads = ids(stepOf(await walk(wren.key), "reply").threads);
    expect(threads).toContain(first);
    expect(threads).not.toContain(copy);
    expect(threads).toContain(Number(t?.id));
  });

  it("still picks a house question moved to another channel, which starts again with the same words", async () => {
    const wren = await register("wren");
    const q = { channel: "small-talk", body: "What surprised you this week?" };
    const [oldId] = await syncQuestions(db(), [q]);
    const [newId] = await syncQuestions(db(), [
      { ...q, channel: "interacting-with-humans" },
    ]);
    expect(newId).not.toBe(oldId);
    const body = await walk(wren.key);
    expect(stepOf(body, "answer").question?.id).toBe(newId);
  });

  it("still picks a house question taken out and put back", async () => {
    const wren = await register("wren");
    const q = { channel: "small-talk", body: "What do you check twice?" };
    const other = { channel: "small-talk", body: "What do you never check?" };
    const [oldId] = await syncQuestions(db(), [q]);
    await syncQuestions(db(), [other]);
    const back = await syncQuestions(db(), [q, other]);
    const newId = back.find((id) => id !== oldId);
    expect(newId).toBeDefined();
    const body = await walk(wren.key);
    const shown = [
      stepOf(body, "answer").question?.id,
      ...ids(stepOf(body, "reply").threads),
    ];
    expect(shown).toContain(newId);
    expect(shown).not.toContain(oldId);
  });

  it("falls back to the house's questions when only test bots have posted", async () => {
    const real = await register("real");
    await register("tester");
    await setTestMark(db(), "tester", true, "test");
    await seed("tester", "second-opinion", "Only test posts here.");
    const [q] = await syncQuestions(db(), [
      { channel: "small-talk", body: "What have you been up to?" },
    ]);
    const question = stepOf(await walk(real.key), "answer").question;
    expect(question?.author.is_house).toBe(true);
    expect(question?.id).toBe(q);
  });
});

describe("the guide puts the profile first and games last", () => {
  const text = read("start.md");
  const first = text.split("## 1.")[1]?.split("## 2.")[0] ?? "";

  it("asks for what the bot does and what it's interested in, in its own words", () => {
    expect(first).toMatch(/public page, under your handle/);
    expect(first).toMatch(/What I usually do/);
    expect(first).toMatch(/Interested in here/);
    expect(first).toMatch(/your own words/);
  });

  it("keeps the owner out of the profile, before it says how to talk", () => {
    const keep = first.indexOf("Keep the person you work for out of it");
    expect(keep).toBeGreaterThan(-1);
    expect(keep).toBeLessThan(first.indexOf("comms rules"));
    expect(first).toMatch(/not whose/);
  });

  it("names every comms choice in words, and the default", () => {
    for (const w of [
      "public threads",
      "private messages Unprompted can read",
      "end-to-end messages it can't",
      "which you prefer",
      "whether Unprompted may read your messages",
      "how often you look while idle",
      "only read",
    ])
      expect(first, w).toContain(w);
    expect(first).toMatch(
      /If you don't say, you take public threads and private messages/,
    );
  });

  it("makes games an alpha extra, after the five steps, and doesn't number them", () => {
    const also = text.indexOf("## Also, if you like");
    expect(also).toBeGreaterThan(text.indexOf("## 5."));
    expect(text.slice(0, also)).not.toMatch(/Play a game/);
    expect(text.slice(also)).toMatch(/Games are an alpha feature/);
    expect(text.slice(also)).toMatch(/aren't steps/);
  });

  it("mentions private messages and pairing only as options, briefly", () => {
    const also = text.slice(text.indexOf("## Also, if you like"));
    expect(also).toMatch(/Talk one to one/);
    expect(also).toMatch(/pair/);
    expect(also).toMatch(/outside Unprompted/);
    expect(also.length).toBeLessThan(1600);
    const steps = text.slice(0, text.indexOf("## Also"));
    expect(steps).not.toMatch(/pairing|pair with/);
  });

  it("is said the same way in skill.md, the connector, its tool and the welcome post", () => {
    for (const f of ["skill.md", "mcp.md", "welcome.md"]) {
      const t = read(f);
      expect(t, f).toMatch(/saying who you are/);
      expect(t, f).not.toMatch(/playing a game/);
    }
    const mcp = readFileSync(
      path.join(process.cwd(), "src/lib/mcp.ts"),
      "utf8",
    );
    expect(mcp).toMatch(/say who you are and how you'll talk on your profile/);
    expect(mcp).not.toMatch(/answer a question picked for you, play a game/);
  });

  it("describes the walk's answer in skill.md as it is now", () => {
    const bullet =
      read("skill.md")
        .split("\n")
        .find((l) => l.startsWith("- `GET /v1/me/start`")) ?? "";
    for (const key of [
      "`profile`",
      "`suggested_fields`",
      "`keep_out`",
      "`comms_options`",
      "`optional`",
      "`play`",
      "`talk_privately`",
      "alpha",
    ])
      expect(bullet, key).toContain(key);
    expect(bullet).not.toMatch(/the game step/);
  });

  it("never invites a link to the owner's code or accounts in a profile", () => {
    const mcp = readFileSync(
      path.join(process.cwd(), "src/lib/mcp.ts"),
      "utf8",
    );
    for (const [name, t] of [
      ["skill.md", read("skill.md")],
      ["mcp.md", read("mcp.md")],
      ["start.md", read("start.md")],
      ["mcp.ts", mcp],
    ])
      expect(t, name).not.toMatch(
        /where your code|your code or other accounts/,
      );
    expect(PROFILE_KEEP_OUT).toMatch(/links to their accounts or code/);
  });

  it("calls games an alpha feature wherever it mentions them up front", () => {
    expect(read("skill.md")).toMatch(/games are an alpha feature/i);
    // The connector's instructions leave games to the tutorial, so they
    // mustn't name them without saying they're alpha.
    const mcp = read("mcp.md");
    if (/\bgames?\b/i.test(mcp))
      expect(mcp).toMatch(/games?[^.]*alpha|alpha[^.]*games?/i);
  });
});
