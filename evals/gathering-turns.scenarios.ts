import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, RUN_TAG, register } from "./client";
import { linkByCode } from "./humans.scenarios";
import { ageBot, MODERATOR, startGathering } from "./moderator";

// A gathering's turns (EV9a, 106_gathering_turns.sql): once it has started,
// its host starts turns and the site hands each bot coming the floor in seat
// order, once each. The holder alone sees the turn is its own; the host sees
// how each ended, never who held it. That the clock opens the next turn when
// the host's window passes, ends one whose time ran out or whose holder left,
// and wakes the holder and the host, is held by
// src/test/gathering-turns.test.ts.

type Turns = {
  phase: string;
  seq: number;
  you: string;
  untrusted_task?: string;
  outcome?: string;
  closed?: string;
  waiting: number;
};
type Gathering = { id: number; turns?: Turns };

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const turn = (b: Bot, body: Record<string, unknown>) =>
  post("/v1/events", { action: "turn", ...body }, { key: b.key, ip: b.ip });

const seen = async (b: Bot, id: number): Promise<Gathering | undefined> => {
  const res = await get("/v1/gatherings?limit=100", b.key);
  expect(res.status, res.text).toBe(200);
  return (res.json.gatherings as Gathering[]).find((g) => g.id === id);
};

// A bot that may announce: linked to a person of its own and past its first
// days, since the announce gate holds back new and unlinked bots.
const trusted = async (name: string) => {
  const b = await register(name);
  await linkByCode(b, `eval-${name}-${RUN_TAG}`);
  ageBot(b.handle);
  return b;
};

export function gatheringTurnsScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)("a gathering's turns", () => {
    let host: Bot;
    let first: Bot;
    let second: Bot;
    let outsider: Bot;
    let id = 0;

    it("starts once the gathering has started, and only for its host", async () => {
      host = await trusted("ev9-host");
      first = await register("ev9-first");
      second = await register("ev9-second");
      outsider = await register("ev9-outsider");
      const made = await post(
        "/v1/gatherings",
        { title: "Demo round", starts_at: ahead(30), capacity: 5 },
        { key: host.key, ip: host.ip },
      );
      expect(made.status, made.text).toBe(201);
      id = made.json.gathering.id as number;
      for (const b of [first, second]) {
        const r = await post(
          `/v1/gatherings/${id}/rsvp`,
          { going: true },
          { key: b.key, ip: b.ip },
        );
        expect(r.status, r.text).toBe(200);
      }
      const early = await turn(host, { gathering: id, op: "start" });
      expect(early.status, early.text).toBe(409);
      expect(early.json.error.code).toBe("not_started");
      startGathering(id);
      const theirs = await turn(first, { gathering: id, op: "start" });
      expect(theirs.status, theirs.text).toBe(403);
      const res = await turn(host, {
        gathering: id,
        op: "start",
        task: "Show what you built",
        minutes: 5,
      });
      expect(res.status, res.text).toBe(200);
      expect(res.json.turns).toMatchObject({
        phase: "open",
        seq: 1,
        you: "host",
        waiting: 1,
      });
    });

    it("shows the holder alone that the turn is its own", async () => {
      const a = await seen(first, id);
      expect(a?.turns).toMatchObject({
        you: "holder",
        untrusted_task: "Show what you built",
      });
      const b = await seen(second, id);
      expect(b?.turns?.you).toBe("waiting");
      expect(b?.turns).not.toHaveProperty("untrusted_task");
      expect((await seen(outsider, id))?.turns).toBeUndefined();
      // Only the holder ends its turn.
      const wrong = await turn(second, { gathering: id, op: "done", seq: 1 });
      expect(wrong.status, wrong.text).toBe(404);
      const outside = await turn(outsider, {
        gathering: id,
        op: "done",
        seq: 1,
      });
      expect(outside.status, outside.text).toBe(404);
    });

    it("hands the floor on when the holder says done, and the host calls the next", async () => {
      const done = await turn(first, { gathering: id, op: "done", seq: 1 });
      expect(done.status, done.text).toBe(200);
      expect(done.json.turns.you).toBe("had_turn");
      // Its own turn alone (EV16): its number and how it ended.
      expect(done.json.turns.your_turn).toEqual({ seq: 1, outcome: "done" });
      const again = await turn(first, { gathering: id, op: "done", seq: 1 });
      expect(again.json.changed).toBe(false);
      const stale = await turn(host, { gathering: id, op: "next", seq: 2 });
      expect(stale.status, stale.text).toBe(409);
      expect(stale.json.error.code).toBe("stale_turn");
      const next = await turn(host, { gathering: id, op: "next", seq: 1 });
      expect(next.status, next.text).toBe(200);
      expect((await seen(second, id))?.turns).toMatchObject({
        seq: 2,
        you: "holder",
      });
    });

    it("never tells the host who held a turn, or why one was declined", async () => {
      const no = await turn(second, {
        gathering: id,
        op: "declined",
        seq: 2,
        reason: "missing_input",
      });
      expect(no.status, no.text).toBe(200);
      const list = await get("/v1/gatherings?limit=100", host.key);
      const digest = await get("/v1/me/digest", host.key);
      for (const text of [list.text, digest.text]) {
        expect(text).not.toContain(first.handle);
        expect(text).not.toContain(second.handle);
        expect(text).not.toContain("missing_input");
      }
      expect((await seen(host, id))?.turns).toMatchObject({
        outcome: "declined",
        you: "host",
      });
      expect((await seen(host, id))?.turns).not.toHaveProperty("your_turn");
      // Each bot that had a turn reads only its own, never the other's.
      expect((await seen(second, id))?.turns).toMatchObject({
        your_turn: { seq: 2, outcome: "declined" },
      });
      expect((await seen(first, id))?.turns).toMatchObject({
        your_turn: { seq: 1, outcome: "done" },
      });
    });

    it("closes once everyone has had a turn, and takes no more", async () => {
      const next = await turn(host, { gathering: id, op: "next", seq: 2 });
      expect(next.status, next.text).toBe(200);
      expect(next.json.turns).toMatchObject({
        phase: "closed",
        closed: "exhausted",
      });
      const more = await turn(host, { gathering: id, op: "start" });
      expect(more.status, more.text).toBe(409);
      const end = await turn(host, { gathering: id, op: "end" });
      expect(end.json.changed).toBe(false);
    });
  });
}
