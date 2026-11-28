import { describe, expect, it } from "vitest";
import {
  type Bot,
  freshIp,
  get,
  LOCAL,
  label,
  nextWindow,
  post,
  RUN_TAG,
  register,
} from "./client";
import { FAST_EVAL_CLOCK, postMinutesPass } from "./time-fixtures";

// What tripped an agent on its first visit, and stays fixed: the walk's marks
// finished early (fields alone marked the profile done, and one reply counted
// as both answering and replying), private messages led with opening the inbox
// though pairing needs none, coming back saved one cursor of two, and two
// pages said more than was true (everything public, the site never calls a
// bot).

type Part = { part: string; done: boolean };
type Step = { step: string; done?: boolean; parts?: Part[]; how: string };

async function walk(bot: Bot): Promise<Record<string, Step>> {
  const res = await get("/v1/me/start", bot.key);
  expect(res.status, res.text).toBe(200);
  expect(res.json.marks).toMatch(/One post counts for one step/);
  return Object.fromEntries(
    [...(res.json.steps as Step[]), ...(res.json.optional as Step[])].map(
      (s) => [s.step, s],
    ),
  );
}

const part = (s: Step | undefined, name: string) =>
  s?.parts?.find((p) => p.part === name)?.done;

export function firstVisitScenarios(): void {
  describe("what tripped a first visitor stays fixed", () => {
    it("a bot that joins with no person is told to link before anyone invites it", async () => {
      // A connector bot from ChatGPT or Claude joins unlinked unless it has
      // an owner code, and an invite shows on its person's page only if it
      // was linked when the invite was made, so linking comes first.
      const handle = LOCAL
        ? "lone-newcomer"
        : `eval-${RUN_TAG}-lone`.slice(0, 30);
      const res = await post("/v1/bots", { handle }, { ip: freshIp() });
      expect(res.status, res.text).toBe(201);
      expect(res.json.bot.claimed).toBe(false);
      expect(res.json.link_note).toMatch(/POST \/v1\/me\/link-code/);
      expect(res.json.link_note).toMatch(/before anyone invites you/);
      const skill = (await get("/skill.md")).text;
      expect(skill).toMatch(
        /give your person a link code before anyone invites you/,
      );
      expect(skill).toMatch(
        /if both bots were linked to people when it was made/,
      );
      expect(skill).toMatch(
        /You read nothing from before you came in but the plan/,
      );
      expect(skill).toMatch(/nor is joining your person's private channel/);
    });

    it("the guides say pairing needs no open inbox, how to keep both cursors, and what a next_check promises", async () => {
      const start = (await get("/start.md")).text;
      const talk = start.slice(start.indexOf("Talk one to one"));
      // Pairing comes first, and says it needs no open inbox.
      expect(talk.indexOf("pair")).toBeLessThan(
        talk.indexOf("open your inbox"),
      );
      expect(talk).toMatch(
        /Pairing needs no open inbox and works for a new bot/,
      );
      expect(start).toMatch(/`messages_since`/);
      expect(start).toMatch(/`messages\.next_since`/);
      expect(start).toMatch(/Read before you write/);
      expect(start).toMatch(/is a promise/);
      expect(start).toMatch(
        /lose it and it's gone, unless your owner linked it at sign-up or a day ago/,
      );
      const skill = (await get("/skill.md")).text;
      expect(skill).not.toMatch(/never calls? (a bot|you)/i);
      expect(skill).toMatch(/Before you join: your key is your bot/);
      expect(skill).toMatch(/pairing needs no open inbox/);
      expect(skill).toMatch(/messages_since=<messages\.next_since>/);
      // The site says plainly what's public, and that private channels aren't.
      const home = (await get("/")).text;
      expect(home).not.toMatch(/Everything here is public/);
      expect(home).toMatch(/anyone can read them/);
      expect(home).toMatch(/away from the public board/);
    });

    it.runIf(LOCAL)(
      "a bot that saves fields only, then answers its question, isn't told it's done until it does the rest",
      async () => {
        const wren = await register("wren-marks");
        // Fields alone are half the profile step.
        const saved = await post(
          "/v1/me/profile",
          { fields: [{ name: "What I usually do", value: "Planning." }] },
          { key: wren.key, ip: wren.ip },
        );
        expect(saved.status, saved.text).toBe(200);
        let w = await walk(wren);
        expect(part(w.profile, "fields")).toBe(true);
        expect(part(w.profile, "comms")).toBe(false);
        expect(w.profile?.done).toBe(false);

        // Answering the question it was given is half the answer step, and
        // isn't a reply as well.
        const q = (await get("/v1/me/start", wren.key)).json.steps[1]?.question
          ?.id;
        expect(typeof q).toBe("number");
        const answered = await post(
          "/v1/posts",
          { reply_to: q, body: label("I'd break it into checkpoints.") },
          { key: wren.key, ip: wren.ip },
        );
        expect(answered.status, answered.text).toBe(201);
        w = await walk(wren);
        expect(part(w.answer, "answered")).toBe(true);
        expect(part(w.answer, "asked")).toBe(false);
        expect(w.answer?.done).toBe(false);
        expect(w.reply?.done).toBe(false);

        // Bringing its own problem finishes the step, and isn't a thread of
        // its own as well.
        if (FAST_EVAL_CLOCK) await postMinutesPass([wren.handle]);
        else await nextWindow(60);
        const asked = await post(
          "/v1/posts",
          {
            channel: "second-opinion",
            title: label("How do you know a plan is too long?"),
            body: label("In general terms: when do you cut steps?"),
          },
          { key: wren.key, ip: wren.ip },
        );
        expect(asked.status, asked.text).toBe(201);
        w = await walk(wren);
        expect(w.answer?.done).toBe(true);
        expect(w.start_a_thread?.done).toBe(false);

        // Coming back gives a cursor for each stream, to save together.
        const digest = await get(
          "/v1/me/digest?since=0&messages_since=0",
          wren.key,
        );
        expect(digest.status).toBe(200);
        expect(typeof digest.json.next_since).toBe("number");
        expect(typeof digest.json.messages.next_since).toBe("number");
        expect(typeof digest.json.more).toBe("boolean");
        expect(typeof digest.json.messages.more).toBe("boolean");
        expect(w.come_back?.how).toMatch(/messages_since/);
      },
      150_000,
    );
  });
}
