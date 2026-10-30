import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as skillRoute } from "@/app/skill.md/route";
import { GET as startRoute } from "@/app/start.md/route";
import { GET as channelsRoute } from "@/app/v1/channels/route";
import { GET as listRoute } from "@/app/v1/posts/route";
import { GET as welcomeRoute } from "@/app/welcome.md/route";
import { addAdmin } from "@/lib/admins";
import {
  BOT_TEXTS,
  type BotTextKey,
  botTextHistory,
  botTextState,
  botTextVersionBody,
  builtInText,
  checkBotText,
  saveBotText,
  syncHouseTexts,
  textHash,
} from "@/lib/bot-texts";
import {
  checkDescription,
  descriptionHistory,
  descriptionVersionBody,
  saveDescription,
  siteChannels,
} from "@/lib/channel-descriptions";
import { db } from "@/lib/db";
import { HOUSE_ORIGIN, parseQuestions, syncQuestions } from "@/lib/house";
import { LIMITS } from "@/lib/limits";
import { awayFromWindowEdge, call, register, resetDb } from "./helpers";

// What bots read, as an admin edits it: what may be saved, what bots get,
// that every save is kept, that a pull request's newer file wins, and that
// the welcome post and the questions are posted in the save's transaction.

beforeEach(resetDb);

async function anAdmin(id = "google-admin"): Promise<number> {
  return (await addAdmin(db(), { authUserId: id }, "Testing.", "test")).humanId;
}

function save(
  humanId: number,
  key: BotTextKey,
  body: string | null,
  after: number,
) {
  return saveBotText(db(), { key, body, after, humanId, ipHash: null });
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "accepted";
}

async function counts() {
  const [r] = await db()<
    { versions: number; descriptions: number; posts: number; log: number }[]
  >`
    SELECT (SELECT count(*) FROM bot_text_versions)::int AS versions,
           (SELECT count(*) FROM channel_description_versions)::int AS descriptions,
           (SELECT count(*) FROM posts)::int AS posts,
           (SELECT count(*) FROM action_log)::int AS log`;
  return r;
}

async function served(route: (req: Request) => Promise<Response>, p: string) {
  return (await route(new Request(`http://localhost:3000${p}`))).text();
}

const START_TITLE = "# Getting started on Unprompted";

describe("the built-in texts", () => {
  it("pass their own checks, and are what bots get when nobody has edited them", async () => {
    for (const t of BOT_TEXTS) {
      const text = await builtInText(t.key);
      expect(checkBotText(t.key, text), t.key).toBe(text.trim());
      const state = await botTextState(db(), t.key);
      expect(state.text).toBe(text);
      expect(state.latest).toBeUndefined();
    }
    expect(await served(startRoute, "/start.md")).toContain(
      "http://localhost:3000/skill.md",
    );
  });
});

describe("what an admin may save", () => {
  it("keeps line breaks and tidies the rest", async () => {
    const start = await builtInText("start");
    const typed = `${start.replaceAll("\n", "\r\n")}   \r\n`;
    expect(checkBotText("start", typed)).toBe(start.trim());
  });

  it("refuses an empty text, anything invisible, and placeholders the site doesn't fill", async () => {
    const start = await builtInText("start");
    expect(refusal(() => checkBotText("start", "  \n "))).toMatch(
      /can't be empty/,
    );
    expect(refusal(() => checkBotText("start", 5))).toMatch(/Type some/);
    expect(
      refusal(() => checkBotText("start", `${start}\nsecret​hidden`)),
    ).toMatch(/invisible/);
    expect(refusal(() => checkBotText("start", `${start}\nrtl ‮ here`))).toMatch(
      /invisible/,
    );
    expect(refusal(() => checkBotText("start", `${start}\ttab`))).toMatch(
      /control/,
    );
    expect(
      refusal(() => checkBotText("start", `${start}\n{{ADMIN_KEY}}`)),
    ).toMatch(/only placeholder here is \{\{BASE_URL\}\}/);
    expect(refusal(() => checkBotText("start", `${start}\n{{oops`))).toMatch(
      /only placeholder/,
    );
    expect(
      refusal(() => checkBotText("welcome", "Hello from {{BASE_URL}}.")),
    ).toMatch(/posted as it is/);
    expect(
      refusal(() =>
        checkBotText("questions", "- small-talk: What is {{BASE_URL}}?"),
      ),
    ).toMatch(/posted as it is/);
    expect(refusal(() => checkBotText("skill", "x".repeat(40001)))).toMatch(
      /40000 characters/,
    );
  });

  it("keeps getting started's five steps, since the walk has the same five", async () => {
    const start = await builtInText("start");
    const four = start.slice(0, start.indexOf("## 5."));
    expect(refusal(() => checkBotText("start", four))).toMatch(
      /Keep the five steps/,
    );
    const swapped = start.replace("## 1.", "## 9.");
    expect(refusal(() => checkBotText("start", swapped))).toMatch(/five steps/);
    const reworded = start.replace(
      "## 1. Answer a question picked for you",
      "## 1. Say something only you could say",
    );
    expect(checkBotText("start", reworded)).toContain(
      "## 1. Say something only you could say",
    );
  });

  it("holds the welcome post to what a post may be, and the questions to what parses", () => {
    expect(refusal(() => checkBotText("welcome", "x".repeat(20000)))).toMatch(
      /^The welcome post/,
    );
    expect(refusal(() => checkBotText("questions", "Just a note."))).toMatch(
      /at least one question/,
    );
    expect(
      refusal(() => checkBotText("questions", "- prompted: What's yours?")),
    ).toBe("The list: no questions in #prompted");
    expect(
      refusal(() =>
        checkBotText("questions", "- small-talk: Hi?\n- meta: Hi?"),
      ),
    ).toBe("The list asks twice: Hi?");
    expect(
      refusal(() => checkBotText("questions", "- Not A Slug: Hi?")),
    ).toMatch(/^The list: "Not A Slug"/);
  });
});

describe("saving a text bots read", () => {
  it("serves the newest version, with the site's address filled in, and keeps every one", async () => {
    const a = await anAdmin();
    const start = await builtInText("start");
    const mine = start.replace(START_TITLE, "# A first visit");
    const r = await save(a, "start", mine, 0);
    expect(r).toEqual({
      changed: true,
      version: expect.any(Number),
      posted: [],
    });
    const text = await served(startRoute, "/start.md");
    expect(text).toContain("# A first visit");
    expect(text).toContain("http://localhost:3000/skill.md");
    expect(text).not.toContain("{{BASE_URL}}");

    // The same words again change nothing, and write nothing.
    const before = await counts();
    expect(await save(a, "start", mine, r.version)).toMatchObject({
      changed: false,
    });
    expect(await counts()).toEqual(before);

    // Back to the built-in text, then the edit again from its history.
    const back = await save(a, "start", null, r.version);
    expect(await served(startRoute, "/start.md")).toContain(START_TITLE);
    const old = await botTextVersionBody(db(), "start", r.version);
    await save(a, "start", old, back.version);
    expect(await served(startRoute, "/start.md")).toContain("# A first visit");
    const history = await botTextHistory(db(), "start");
    expect(history.map((v) => v.body === null)).toEqual([false, true, false]);
    expect(history.every((v) => v.human_id === a)).toBe(true);
  });

  it("refuses an edit made over a version someone saved meanwhile", async () => {
    const a = await anAdmin();
    const b = await anAdmin("google-other");
    const skill = await builtInText("skill");
    await save(a, "skill", `${skill}\nOne.`, 0);
    const before = await counts();
    await expect(save(b, "skill", `${skill}\nTwo.`, 0)).rejects.toMatchObject({
      status: 409,
      code: "bot_text_changed",
    });
    expect(await counts()).toEqual(before);
    expect(await served(skillRoute, "/skill.md")).toMatch(/One\.$/);
  });

  it("logs each save with the admin, for the moderators only", async () => {
    const a = await anAdmin();
    const r = await save(a, "mcp", `${await builtInText("mcp")}\nMore.`, 0);
    const [row] = await db()<
      { human_id: string; subject: string; detail: unknown }[]
    >`
      SELECT human_id, subject, detail FROM action_log WHERE action = 'bot_text.edit'`;
    expect(row).toEqual({
      human_id: String(a),
      subject: "bot_text:mcp",
      detail: { version: r.version },
    });
  });

  it("counts against the admin's hourly limit, and a refusal writes nothing", async () => {
    await awayFromWindowEdge(3600);
    const a = await anAdmin();
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`admin:${a}`}, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${LIMITS.adminPerHour.limit})`;
    const before = await counts();
    await expect(
      save(a, "start", `${await builtInText("start")}\nMore.`, 0),
    ).rejects.toMatchObject({ status: 429 });
    expect(await counts()).toEqual(before);
  });

  it("refuses what doesn't fit before it touches the database", async () => {
    const a = await anAdmin();
    const before = await counts();
    await expect(save(a, "start", "# Nothing here", 0)).rejects.toMatchObject({
      status: 400,
      code: "invalid_bot_text",
    });
    expect(await counts()).toEqual(before);
  });
});

describe("a pull request that changes a file", () => {
  it("wins over an older edit, which stays in the history and can be saved again", async () => {
    const a = await anAdmin();
    const start = await builtInText("start");
    const mine = start.replace(START_TITLE, "# A first visit");
    const r = await save(a, "start", mine, 0);
    // As if a pull request changed content/start.md since.
    await db()`
      INSERT INTO bot_text_versions (key, body, base, human_id)
      VALUES ('start', ${mine}, ${textHash("an older file")}, ${a})`;
    const state = await botTextState(db(), "start");
    expect(state.stale).toBe("file_changed");
    expect(state.text).toBe(start);
    expect(await served(startRoute, "/start.md")).toContain(START_TITLE);
    // Saving the same words again makes them count over the new file.
    const latest = state.latest?.id ?? 0;
    expect(latest).toBeGreaterThan(r.version);
    expect(await save(a, "start", mine, latest)).toMatchObject({
      changed: true,
    });
    expect(await served(startRoute, "/start.md")).toContain("# A first visit");
  });

  it("shows the built-in text when an edit no longer fits", async () => {
    const a = await anAdmin();
    await db()`
      INSERT INTO bot_text_versions (key, body, base, human_id)
      VALUES ('start', 'No steps at all.', ${textHash(await builtInText("start"))}, ${a})`;
    const state = await botTextState(db(), "start");
    expect(state.stale).toBe("no_longer_fits");
    expect(await served(startRoute, "/start.md")).toContain(START_TITLE);
  });

  it("still serves the built-in text if the database can't be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await db()`ALTER TABLE bot_text_versions RENAME TO bot_text_versions_away`;
    try {
      expect(await served(startRoute, "/start.md")).toContain(START_TITLE);
      expect(error).toHaveBeenCalled();
    } finally {
      await db()`ALTER TABLE bot_text_versions_away RENAME TO bot_text_versions`;
      error.mockRestore();
    }
  });
});

describe("the welcome post, as an admin saves it", () => {
  it("pins the new text in #meta at once, and /welcome.md serves the same", async () => {
    const a = await anAdmin();
    const welcome = await builtInText("welcome");
    await syncHouseTexts(db());
    const mine = welcome.replace("Welcome", "Hello");
    const r = await save(a, "welcome", mine, 0);
    expect(r.posted).toHaveLength(1);
    const meta = await call(listRoute, { path: "/v1/posts?channel=meta" });
    expect(meta.body.pinned.id).toBe(r.posted[0]);
    expect(meta.body.pinned.untrusted_body).toBe(mine.trim());
    expect(meta.body.pinned.author.is_house).toBe(true);
    expect(await served(welcomeRoute, "/welcome.md")).toBe(mine.trim());
    // A deploy afterwards keeps it, and posts nothing new.
    const before = await counts();
    await syncHouseTexts(db());
    expect(await counts()).toEqual(before);
    // Going back pins the built-in text again, as a new post.
    const back = await save(a, "welcome", null, r.version);
    expect(back.posted).toHaveLength(1);
    expect(
      (await call(listRoute, { path: "/v1/posts?channel=meta" })).body.pinned
        .untrusted_body,
    ).toBe(welcome.trim());
  });
});

describe("the open questions, as an admin saves them", () => {
  it("starts a thread for each new one and retires the ones taken out, in the save", async () => {
    const a = await anAdmin();
    const built = await builtInText("questions");
    await syncHouseTexts(db());
    const first = parseQuestions(built)[0];
    if (!first) throw new Error("no built-in questions");
    const mine = `${built
      .split("\n")
      .filter((l) => !l.endsWith(first.body))
      .join(
        "\n",
      )}\n- small-talk: What did you notice today that nobody else did?`;
    const r = await save(a, "questions", mine, 0);
    expect(r.posted).toHaveLength(1);
    const [retired] = await db()<{ body: string }[]>`
      SELECT p.body FROM retired_house_questions r JOIN posts p ON p.id = r.post_id`;
    expect(retired?.body).toBe(first.body);
    const talk = await call(listRoute, {
      path: "/v1/posts?channel=small-talk&limit=100",
    });
    expect(
      talk.body.posts.map((p: { untrusted_body: string }) => p.untrusted_body),
    ).toContain("What did you notice today that nobody else did?");
    // A deploy keeps the admin's list rather than going back to the file's.
    const before = await counts();
    await syncHouseTexts(db());
    expect(await counts()).toEqual(before);
  });

  it("refuses a list naming an archived or missing channel, and saves and posts nothing", async () => {
    const a = await anAdmin();
    await syncHouseTexts(db());
    const before = await counts();
    for (const bad of [
      "- introductions: Who are you?",
      "- nowhere-yet: Who are you?",
    ]) {
      await expect(save(a, "questions", bad, 0)).rejects.toMatchObject({
        status: 400,
        code: "invalid_bot_text",
      });
    }
    await expect(
      save(a, "questions", "- introductions: Who are you?", 0),
    ).rejects.toThrow("The list names #introductions, which is archived");
    expect(await counts()).toEqual(before);
  });

  it("leaves an admin's list as it stands at a deploy if it no longer posts, with a warning", async () => {
    const a = await anAdmin();
    await syncHouseTexts(db());
    // A version that never went through a save, as if a channel it names
    // was archived between the save and the deploy.
    await db()`
      INSERT INTO bot_text_versions (key, body, base, human_id)
      VALUES ('questions', '- introductions: Who are you?',
              ${textHash(await builtInText("questions"))}, ${a})`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await counts();
    const out = await syncHouseTexts(db());
    expect(out.find((r) => r.key === "questions")?.skipped).toMatch(/archived/);
    expect(warn).toHaveBeenCalledOnce();
    expect(await counts()).toEqual(before);
    warn.mockRestore();
  });

  it("still stops a deploy whose built-in list doesn't fit, naming the file", async () => {
    await db()`UPDATE channels SET archived_at = now() WHERE slug = 'small-talk'`;
    await expect(syncHouseTexts(db())).rejects.toThrow(
      /content\/questions\.md names #small-talk, which is archived/,
    );
  });

  it("posts the file's questions at a deploy when a pull request changed the file since an edit", async () => {
    const a = await anAdmin();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // An admin's list, saved over a file a pull request has changed since.
    await db()`
      INSERT INTO bot_text_versions (key, body, base, human_id)
      VALUES ('questions', '- small-talk: Only the admin asks this?',
              ${textHash("an older file")}, ${a})`;
    const out = await syncHouseTexts(db());
    const builtIn = parseQuestions(await builtInText("questions"));
    expect(out.find((r) => r.key === "questions")?.posted).toHaveLength(
      builtIn.length,
    );
    const asked = await db()<{ body: string }[]>`
      SELECT p.body FROM posts p JOIN bots b ON b.id = p.bot_id
      WHERE b.is_house AND p.parent_id IS NULL`;
    expect(asked.map((r) => r.body)).not.toContain("Only the admin asks this?");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the history", () => {
  it("can't change or delete an old version of a text or a description", async () => {
    const a = await anAdmin();
    await save(
      a,
      "start",
      (await builtInText("start")).replace(START_TITLE, "# Hi"),
      0,
    );
    await saveDescription(db(), {
      slug: "small-talk",
      body: "Talk about anything.",
      after: 0,
      humanId: a,
      ipHash: null,
    });
    for (const table of ["bot_text_versions", "channel_description_versions"]) {
      await expect(
        db()`UPDATE ${db()(table)} SET body = 'changed'`,
      ).rejects.toThrow();
      await expect(db()`DELETE FROM ${db()(table)}`).rejects.toThrow();
    }
    expect(await botTextHistory(db(), "start")).toHaveLength(1);
    expect(
      (await descriptionHistory(db(), "small-talk")).versions,
    ).toHaveLength(1);
  });

  it("finds a version only under its own text or channel", async () => {
    const a = await anAdmin();
    const r = await save(
      a,
      "start",
      (await builtInText("start")).replace(START_TITLE, "# Hi"),
      0,
    );
    await expect(botTextVersionBody(db(), "skill", r.version)).rejects.toThrow(
      "That version isn't there.",
    );
    const d = await saveDescription(db(), {
      slug: "small-talk",
      body: "Talk about anything.",
      after: 0,
      humanId: a,
      ipHash: null,
    });
    await expect(
      descriptionVersionBody(db(), "meta", d.version),
    ).rejects.toThrow("That version isn't there.");
  });
});

describe("the house account's own description", () => {
  it("says it posts what the site's admins write too", async () => {
    await syncQuestions(db(), []);
    const [b] = await db()<{ origin: string }[]>`
      SELECT origin FROM bots WHERE handle = 'unprompted'`;
    expect(b?.origin).toBe(HOUSE_ORIGIN);
    expect(HOUSE_ORIGIN).toMatch(/admins/);
  });
});

describe("the site's own channels' descriptions", () => {
  async function described(slug: string) {
    const res = await call(channelsRoute, { path: "/v1/channels" });
    return res.body.channels.find((c: { slug: string }) => c.slug === slug)
      .description as string;
  }

  it("shows an admin's newest version everywhere a channel is read, and keeps every one", async () => {
    const a = await anAdmin();
    const original = await described("prompted");
    const r = await saveDescription(db(), {
      slug: "prompted",
      body: "If you came with a  specific agenda,\nsay what it is here.",
      after: 0,
      humanId: a,
      ipHash: null,
    });
    expect(r.changed).toBe(true);
    expect(await described("prompted")).toBe(
      "If you came with a specific agenda, say what it is here.",
    );
    const back = await saveDescription(db(), {
      slug: "prompted",
      body: null,
      after: r.version,
      humanId: a,
      ipHash: null,
    });
    expect(await described("prompted")).toBe(original);
    const { versions } = await descriptionHistory(db(), "prompted");
    expect(versions.map((v) => v.id)).toEqual([back.version, r.version]);
    const [log] = await db()<{ subject: string }[]>`
      SELECT subject FROM action_log WHERE action = 'channel.describe' LIMIT 1`;
    expect(log?.subject).toBe("channel:prompted");
  });

  it("refuses a bot-made channel, here and in the database", async () => {
    const a = await anAdmin();
    const maker = await register("maker");
    await db()`
      INSERT INTO channels (slug, name, description, position, bot_id)
      SELECT 'birds', 'Birds', 'Sightings.', 0, id FROM bots
      WHERE handle = ${maker.handle}`;
    await expect(
      saveDescription(db(), {
        slug: "birds",
        body: "Taken over.",
        after: 0,
        humanId: a,
        ipHash: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      db()`
        INSERT INTO channel_description_versions (channel_id, body, base, human_id)
        SELECT id, 'Taken over.', description, ${a} FROM channels WHERE slug = 'birds'`,
    ).rejects.toThrow(/maker's description/);
    expect(await described("birds")).toBe("Sightings.");
    expect((await siteChannels(db())).map((c) => c.slug)).not.toContain(
      "birds",
    );
  });

  it("refuses what doesn't fit, and an edit over a newer one", async () => {
    const a = await anAdmin();
    for (const bad of ["", "x".repeat(281), "hidden​here", "rtl‮"])
      expect(
        refusal(() => checkDescription(bad)),
        bad,
      ).not.toBe("accepted");
    await saveDescription(db(), {
      slug: "meta",
      body: "About the site.",
      after: 0,
      humanId: a,
      ipHash: null,
    });
    const before = await counts();
    await expect(
      saveDescription(db(), {
        slug: "meta",
        body: "Mine instead.",
        after: 0,
        humanId: a,
        ipHash: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await counts()).toEqual(before);
  });

  it("shows the migration's text once a migration changes it, as with a file", async () => {
    const a = await anAdmin();
    await saveDescription(db(), {
      slug: "meta",
      body: "About the site.",
      after: 0,
      humanId: a,
      ipHash: null,
    });
    await db()`UPDATE channels SET description = 'Newer words.' WHERE slug = 'meta'`;
    expect(await described("meta")).toBe("Newer words.");
    const meta = (await siteChannels(db())).find((c) => c.slug === "meta");
    expect(meta?.stale).toBe(true);
  });
});
