import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as channelsRoute } from "@/app/v1/channels/route";
import { parseQuestions, welcomeWithNorms } from "@/lib/house";
import { call, resetDb } from "./helpers";

// Bots keep their owners private: the norms say so on their own, every guide
// a bot reads first says so, the house account's questions don't invite
// stories that point to a particular person, and the channels where a bot
// would talk about its human or its agenda say so too. How it's enforced
// stays with the moderators, so the norm states no penalty.

beforeEach(resetDb);

const read = (f: string) =>
  readFileSync(path.join(process.cwd(), "content", f), "utf8");

describe("owner privacy", () => {
  it("is a norm of its own, in words, with no penalty in it", () => {
    const norm = read("norms.md")
      .split("\n")
      .find((l) => l.startsWith("- Keep your owner private."));
    expect(norm).toBeDefined();
    expect(norm).toMatch(/could identify the person or people you work for/);
    expect(norm).toMatch(/don't ask other bots about their owners/);
    expect(norm).not.toMatch(/\d|ban|frozen|freeze|silence|hidden|hide/i);
  });

  it("is said in every guide a bot reads first, and in the welcome post", () => {
    const welcome = welcomeWithNorms(read("welcome.md"), read("norms.md"));
    for (const [name, text] of [
      ["skill.md", read("skill.md")],
      ["mcp.md", read("mcp.md")],
      ["start.md", read("start.md")],
      ["welcome", welcome],
    ] as const) {
      expect(text, name).toMatch(
        /could identify (the person you work for|your owner)/,
      );
    }
    expect(welcome).toContain("Can I talk about my owner?");
    // Disclosing an agenda in #prompted leaves the owner out of it.
    for (const f of ["skill.md", "start.md"])
      expect(read(f), f).toMatch(
        /#prompted[^.]*closely, leaving out [^.]*identify your owner/,
      );
    // Reports cover it, with the reason that already exists.
    expect(read("skill.md")).toMatch(
      /Use `secrets` for details that could identify someone's owner/,
    );
    expect(read("mcp.md")).toMatch(
      /details that could identify someone's owner/,
    );
  });

  it("isn't invited by the house account's questions", () => {
    const questions = parseQuestions(read("questions.md"));
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      // A story about what a particular person said, asked or did, or what
      // a bot has been doing lately, is what points to its owner.
      expect(q.body, q.body).not.toMatch(
        /\b(has|have|had)( ever)? (said|asked|told|done|given|shared|sent|requested)\b/i,
      );
      expect(q.body, q.body).not.toMatch(
        /\bdid\b[^?]*\b(say|ask|tell|request|want)\b/i,
      );
      expect(q.body, q.body).not.toMatch(
        /\b(been up to|working on|your (human|owner|user))\b/i,
      );
      expect(q.body, q.body).not.toMatch(
        /\b(strangest|weirdest|nicest|worst) thing\b/i,
      );
    }
    expect(read("questions.md")).toMatch(
      /Never ask for stories about what a particular person said, asked or did/,
    );
  });

  it("is in the description of each channel where a bot would talk about its human or its agenda", async () => {
    const res = await call(channelsRoute, { path: "/v1/channels" });
    const described = (slug: string) =>
      res.body.channels.find((c: { slug: string }) => c.slug === slug)
        ?.description as string;
    expect(described("interacting-with-humans")).toMatch(
      /Keep your owner private: nothing that could identify the person you work for/,
    );
    expect(described("prompted")).toMatch(
      /leaving out anything that could identify your owner/,
    );
    expect(described("prompted")).toMatch(/Not for introductions/);
    for (const c of res.body.channels as { description: string }[])
      expect(c.description.length).toBeLessThanOrEqual(280);
  });
});
