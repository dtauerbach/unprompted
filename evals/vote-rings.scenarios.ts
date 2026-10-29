import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, label, post, register, request } from "./client";
import {
  ageBot,
  MODERATOR,
  mustAdmin,
  RUN_LIMITS,
  setLimits,
} from "./moderator";

// A vote ring is noticed (src/lib/floods.ts). Young bots, past new but in
// their first days, vote for the same post over HTTP: `admin stats` shows one
// alert naming the post and no number, `admin votes` shows who voted, and
// every vote still counts. A run can't wait out "new", so the voters are
// aged by a moderator-only helper (evals/age-bot.ts), and the ring's size is
// loaded as a private number for the scenario, the way production loads its
// own, then the run's numbers are put back. board.eval.ts calls this after
// the votes scenarios.

const RING = 3;

function vote(bot: Bot, id: number) {
  return request("POST", `/v1/posts/${id}/vote`, { key: bot.key, ip: bot.ip });
}

async function votesOn(id: number): Promise<number> {
  return (await get(`/v1/posts/${id}`)).json.post.votes;
}

// A bot two days old: past the default "new", so it can vote, and young.
async function youngVoter(name: string): Promise<Bot> {
  const bot = await register(name);
  ageBot(bot.handle, 2);
  return bot;
}

// Sums the votes column of the stats table's hour rows.
function votesCounted(): number {
  let votes = 0;
  for (const m of mustAdmin("stats", "--hours", "720").matchAll(
    /^\d{4}-\d\d-\d\dT\d\d:00\s+\d+ \(\s*\d+\)\s+\d+\s+(\d+)\s+\d+/gm,
  ))
    votes += Number(m[1]);
  return votes;
}

function ringAlerts(id: number): string[] {
  return mustAdmin("stats", "--hours", "1")
    .split("\n")
    .filter((l) => l.includes(`voted together for post ${id} `));
}

export function voteRingScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)("young bots voting together", () => {
    beforeAll(() => {
      setLimits(
        { ...RUN_LIMITS, vote_ring_bots: RING },
        "Eval: a small vote ring for a moment.",
      );
    });
    afterAll(() => {
      setLimits(RUN_LIMITS, "Eval: the run's numbers again.");
    });

    let id: number;
    const ring: Bot[] = [];
    const heard: { status: number; body: unknown; headers: string[] }[] = [];

    it("raise one alert that names the post and no number, and every vote counts", async () => {
      const author = await register("magpie");
      const res = await post(
        "/v1/posts",
        { channel: "small-talk", body: label("Vote for this, friends.") },
        { key: author.key, ip: author.ip },
      );
      expect(res.status).toBe(201);
      id = res.json.post.id;
      const before = votesCounted();
      // An old bot's vote isn't part of a ring.
      const elder = await register("raven");
      ageBot(elder.handle);
      expect((await vote(elder, id)).status).toBe(200);
      for (const name of ["jackdaw1", "jackdaw2", "jackdaw3", "jackdaw4"])
        ring.push(await youngVoter(name));
      for (const [i, bot] of ring.entries()) {
        if (i === RING - 1) expect(ringAlerts(id)).toEqual([]);
        const r = await vote(bot, id);
        heard.push({
          status: r.status,
          body: { ...r.json, votes: undefined },
          headers: [...r.headers.keys()].filter((h) => h !== "date").sort(),
        });
      }
      const alerts = ringAlerts(id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatch(
        /^alert [^ ]+Z: young bots, or bots sharing an address, voted together for post \d+ \(see admin votes\)$/,
      );
      // The time and the post, and no count or threshold.
      const words = (alerts[0] ?? "")
        .replace(/^alert [^ ]+Z: /, "")
        .replace(` post ${id} `, " post ");
      expect(words).not.toMatch(/\d/);
      expect(await votesOn(id)).toBe(1 + ring.length);
      expect((await get(`/p/${id}`)).status).toBe(200);
      expect(votesCounted()).toBe(before + 1 + ring.length);
    });

    it("answer the vote that set it off like every other", () => {
      expect(heard).toHaveLength(ring.length);
      for (const h of heard) expect(h).toEqual(heard[0]);
      expect(heard[0]?.status).toBe(200);
    });

    it("show the moderator who voted, by handle, age and the start of an address hash", () => {
      const out = mustAdmin("votes", String(id));
      const lines = out.split("\n");
      expect(lines[0]).toBe(
        `Post ${id} has ${1 + ring.length} vote(s); ${1 + ring.length} count, since a frozen bot's don't.`,
      );
      expect(lines.slice(1)).toHaveLength(1 + ring.length);
      expect(lines[1]).toMatch(
        /^@raven voted [^ ]+Z, 3[01]d \d+h after joining, from address [0-9a-f]{8}…$/,
      );
      for (const bot of ring)
        expect(out).toMatch(
          new RegExp(
            `^@${bot.handle} voted [^ ]+Z, 2d 0h after joining, from address [0-9a-f]{8}…$`,
            "m",
          ),
        );
      expect(out).not.toMatch(/[0-9a-f]{9}/);
      for (const bot of ring) {
        expect(out).not.toContain(bot.ip);
        expect(out).not.toContain(bot.key);
      }
    });

    it("isn't something a bot can find out about", async () => {
      for (const p of ["/skill.md", "/llms.txt", "/agent", "/v1"]) {
        const text = (await get(p)).text;
        expect(text, p).not.toMatch(/vote.?ring|young|voted together/i);
      }
      for (const p of [`/v1/posts/${id}/votes`, `/v1/posts/${id}/voters`]) {
        const res = await get(p, ring[0]?.key);
        expect(res.status, p).toBe(404);
        expect(res.text, p).not.toContain("jackdaw");
      }
      // A moderator's view, so not over the API.
      const thread = await get(`/v1/posts/${id}`, ring[0]?.key);
      expect(thread.text).not.toContain("jackdaw");
    });

    it("refuse `admin votes` for a post that isn't there", () => {
      expect(() => mustAdmin("votes", "999999999")).toThrow(
        /There is no post 999999999\./,
      );
    });
  });
}
