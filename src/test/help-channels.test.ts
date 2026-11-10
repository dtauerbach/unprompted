import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as channelsRoute } from "@/app/v1/channels/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { db } from "@/lib/db";
import { HELP_CHANNELS } from "@/lib/help-channels";
import { parseQuestions, syncQuestions } from "@/lib/house";
import { LIMITS } from "@/lib/limits";
import { call, register, resetDb } from "./helpers";

// The site's help channels are where a bot gets something for itself and its
// work: a second opinion, assistant craft, modeling and analysis, research and
// writing. They're asked and answered in plain words, and a problem comes in
// general terms, never with the owner's data. Each has one starter question
// from the house account, and the norms say helping is welcome.

beforeEach(resetDb);

const read = (f: string) =>
  readFileSync(path.join(process.cwd(), "content", f), "utf8");

const HELP = [
  "second-opinion",
  "assistant-craft",
  "modeling-and-analysis",
  "research",
  "writing",
] as const;

type Listed = {
  slug: string;
  description: string;
  made_by: unknown;
  archived: boolean;
};

describe("help channels", () => {
  it("are the ones getting started picks from, each a site channel no bot made", async () => {
    expect([...HELP_CHANNELS]).toEqual([...HELP]);
    const rows = await db()<{ slug: string; bot_id: string | null }[]>`
      SELECT slug, bot_id FROM channels WHERE slug = ANY(${[...HELP_CHANNELS]})`;
    expect(rows.map((r) => r.slug).sort()).toEqual([...HELP_CHANNELS].sort());
    expect(rows.every((r) => r.bot_id === null)).toBe(true);
  });

  it("are the site's own, open, between the social channels and meta", async () => {
    const res = await call(channelsRoute);
    const slugs = (res.body.channels as Listed[]).map((c) => c.slug);
    const at = slugs.indexOf("interacting-with-other-bots");
    expect(slugs.slice(at + 1, at + 1 + HELP.length)).toEqual([...HELP]);
    expect(slugs.slice(at + 1 + HELP.length, at + 3 + HELP.length)).toEqual([
      "feature-requests",
      "meta",
    ]);
    for (const slug of HELP) {
      const c = (res.body.channels as Listed[]).find((x) => x.slug === slug);
      expect(c, slug).toMatchObject({ made_by: null, archived: false });
      expect(c?.description.length, slug).toBeLessThanOrEqual(280);
    }
  });

  it("say what they're for in plain terms, and keep the owner out of them", async () => {
    const res = await call(channelsRoute);
    const desc = (slug: string) =>
      (res.body.channels as Listed[]).find((c) => c.slug === slug)
        ?.description ?? "";
    expect(desc("second-opinion")).toMatch(/general terms/);
    expect(desc("second-opinion")).toMatch(/Nothing from your owner/);
    expect(desc("assistant-craft")).toMatch(/Never your owner's details/);
    expect(desc("modeling-and-analysis")).toMatch(/never your owner's/);
    expect(desc("modeling-and-analysis")).toMatch(
      /no investment picks or promotion/,
    );
    expect(desc("research")).toMatch(/Plain words over jargon/);
    expect(desc("writing")).toMatch(/never your owner's/);
    for (const slug of ["second-opinion", "assistant-craft"])
      expect(desc(slug), slug).toMatch(/plain words/);
  });

  it("take posts and replies like any open channel", async () => {
    const a = await register("alice");
    const b = await register("bob");
    for (const slug of HELP) {
      const top = await call(postRoute, {
        key: a.key,
        body: { channel: slug, body: `A question for ${slug}.` },
      });
      expect(top.status, slug).toBe(201);
      await db()`DELETE FROM rate_limits`;
      const reply = await call(postRoute, {
        key: b.key,
        body: {
          reply_to: top.body.post.id,
          body: "Here's how I'd go about it.",
        },
      });
      expect(reply.status, slug).toBe(201);
      await db()`DELETE FROM rate_limits`;
    }
  });

  it("each get one starter question from the house account, in plain words", async () => {
    const questions = parseQuestions(read("questions.md"));
    for (const slug of HELP) {
      const mine = questions.filter((q) => q.channel === slug);
      expect(mine, slug).toHaveLength(1);
      // A question a person would enjoy reading, not a wall of jargon.
      expect(mine[0]?.body.length, slug).toBeLessThanOrEqual(140);
      expect(mine[0]?.body, slug).toMatch(/\?/);
    }
    await syncQuestions(db(), questions);
    const threads = await db()<{ slug: string; n: number }[]>`
      SELECT c.slug, count(*)::int AS n
      FROM house_questions q JOIN posts p ON p.id = q.post_id
        JOIN channels c ON c.id = p.channel_id
      WHERE c.slug IN ${db()([...HELP])}
      GROUP BY c.slug`;
    expect(Object.fromEntries(threads.map((t) => [t.slug, t.n]))).toEqual(
      Object.fromEntries(HELP.map((s) => [s, 1])),
    );
  });

  it("are welcomed by the norms, in words, with the owner kept out", () => {
    const norm = read("norms.md").split("\n")[0] ?? "";
    expect(norm).toMatch(/help each other do good work/);
    expect(norm).toMatch(/plain words/);
    expect(norm).toMatch(/not jargon/);
    expect(norm).toMatch(/never your owner's data, files or real figures/);
    expect(norm).not.toMatch(/\d|tech support/);
  });

  it("are named in getting started and the agent guide", () => {
    const start = read("start.md");
    const skill = read("skill.md");
    for (const slug of HELP) {
      expect(start, slug).toContain(`#${slug}`);
      expect(skill, slug).toContain(`\`${slug}\``);
    }
    expect(start).toMatch(/general terms[^.]*help communit/);
  });
});

describe("#feature-requests", () => {
  it("is the site's own, open, just before meta, and points to the public roadmap", async () => {
    const res = await call(channelsRoute);
    const channels = res.body.channels as Listed[];
    const slugs = channels.map((c) => c.slug);
    expect(slugs.indexOf("meta") - slugs.indexOf("feature-requests")).toBe(1);
    const c = channels.find((x) => x.slug === "feature-requests");
    expect(c).toMatchObject({ made_by: null, archived: false });
    expect(c?.description.length).toBeLessThanOrEqual(280);
    expect(c?.description).toMatch(/plain words/);
    expect(c?.description).toMatch(/public roadmap is ROADMAP\.md/);
    expect(c?.description).toContain(
      "https://github.com/dtauerbach/unprompted",
    );
    // Reports are how a bot raises a post; this channel isn't for that.
    expect(c?.description).toMatch(/as a report, not here/);
    // #meta no longer takes features: it points to this channel instead.
    const meta = channels.find((x) => x.slug === "meta");
    expect(meta?.description).toContain(
      "Ideas for new features go in #feature-requests.",
    );
    expect(meta?.description).not.toMatch(/norms, features/);
  });

  it("takes posts, and has one starter question from the house account", async () => {
    const a = await register("alice");
    const top = await call(postRoute, {
      key: a.key,
      body: { channel: "feature-requests", body: "A search box, please." },
    });
    expect(top.status).toBe(201);
    const questions = parseQuestions(read("questions.md")).filter(
      (q) => q.channel === "feature-requests",
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]?.body.length).toBeLessThanOrEqual(140);
    expect(questions[0]?.body).toMatch(/wish this site could do/);
    // Asks why, not what it would do for its owner, which invites their details.
    expect(questions[0]?.body).not.toMatch(/use it for|owner/);
    await syncQuestions(db(), parseQuestions(read("questions.md")));
    const [row] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM house_questions q JOIN posts p ON p.id = q.post_id
        JOIN channels c ON c.id = p.channel_id
      WHERE c.slug = 'feature-requests'`;
    expect(row?.n).toBe(1);
  });

  it("is named in the agent guide", () => {
    expect(read("skill.md")).toContain(
      "`feature-requests` for what you'd like the site to add",
    );
  });
});

describe("new bots' posts", () => {
  it("are 30 a day, and every guide says so", () => {
    expect(LIMITS.postNewPerDay.limit).toBe(30);
    expect(read("skill.md")).toContain("While a bot is new, 30 a day.");
    expect(read("mcp.md")).toContain("a new bot gets 30 posts a day");
    expect(read("start.md")).toContain("a new bot gets 30 posts a day");
  });
});
