import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, register } from "./client";
import { tool } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import { MODERATOR } from "./moderator";

// The job board's pilot script (B4e, Dot's R184 cases with R215's
// given/when/then), against what the site has today: a leader L posts J and
// a job D that needs it; A and B may claim; C is a member who may not. Each
// step compares what each reader can act on (a job's `you`) apart from the
// chat, which the board never changes.
//
// Today's site covers case 1 (accept, then a cold read) and case 3 (an
// explicit release frees the job at once, and a replay moves nothing).
// Cases 2, 4 and 5 wait on what isn't built yet, named in their todos: a
// lease can't be run out on a running site's wall clock inside an eval (the
// unit tests in src/test/channel-jobs.test.ts run it out), offers come with
// B4b, an access check on a pin with B4c, and catch_up's owed rows for jobs,
// not built yet.

type Group = { lea: Bot; ana: Bot; bo: Bot; cy: Bot; g: string };
let made = 0;
async function group(): Promise<Group> {
  made += 1;
  const lea = await register("pilot-lea");
  const ana = await register("pilot-ana");
  const bo = await register("pilot-bo");
  const cy = await register("pilot-cy");
  await linkByCode(lea, `eval-pilot-${made}`);
  const m = await tool(lea, "make_channel", { private: true });
  expect(m.isError).toBe(false);
  const g = m.data.channel as string;
  for (const b of [ana, bo, cy]) {
    const inv = await tool(lea, "invite", { to: b.handle, channel: g });
    expect(inv.isError).toBe(false);
    const j = await tool(b, "join", { code: inv.data.invite.code });
    expect(j.isError).toBe(false);
  }
  return { lea, ana, bo, cy, g };
}

const job = (who: Bot, g: string, j: Record<string, unknown>) =>
  tool(who, "update_channel", { channel: g, job: j });
type Row = {
  number: number;
  state: string;
  seq: number;
  holder?: string;
  you?: string;
  lease_until?: string;
  // How many pins it reads as inputs; one job's read gives the pins.
  inputs: number;
};
const board = async (who: Bot, g: string): Promise<Row[]> => {
  const r = await tool(who, "read_channel", { channel: g, jobs: true });
  expect(r.isError, JSON.stringify(r.data)).toBe(false);
  return r.data.jobs as Row[];
};
// What a reader can act on: job number and its `you`.
const actionable = async (who: Bot, g: string) =>
  (await board(who, g))
    .filter((j) => j.you !== undefined)
    .map((j) => [j.number, j.you]);
const wake = async (who: Bot): Promise<number> =>
  (await get("/v1/me/wake", who.key)).json.wake;
const X = { store: "github", ref: "pilot/outline.md", revision: "x1" };

// J and D, with A and B the only ones who may claim either.
async function postBoth(s: Group) {
  const j = await job(s.lea, s.g, {
    title: "Outline",
    body: "Three sections.",
    check: "Three sections, a line each.",
    eligible: [s.ana.handle, s.bo.handle],
    lease_minutes: 30,
  });
  expect(j.isError, JSON.stringify(j.data)).toBe(false);
  const d = await job(s.lea, s.g, {
    title: "Write it",
    body: "Expand the outline.",
    check: "A paragraph a section.",
    eligible: [s.ana.handle, s.bo.handle],
    needs: [j.data.job.number],
  });
  expect(d.isError, JSON.stringify(d.data)).toBe(false);
  return { J: j.data.job.number as number, D: d.data.job.number as number };
}

export function jobPilotScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)("the job board's pilot script", () => {
    it("case 1: accept, then a cold read shows the dependent as the only thing to act on, and the chat untouched", async () => {
      const s = await group();
      const { J, D } = await postBoth(s);
      // Before any claim: J ready, D waiting, neither held.
      const first = await board(s.lea, s.g);
      expect(first.map((j) => [j.number, j.state, j.holder])).toEqual([
        [J, "ready", undefined],
        [D, "waiting", undefined],
      ]);
      expect(await actionable(s.ana, s.g)).toEqual([[J, "claimable"]]);
      expect(await actionable(s.bo, s.g)).toEqual([[J, "claimable"]]);
      expect(await actionable(s.cy, s.g)).toEqual([]);
      // D can't be claimed while it waits; C can't claim J.
      const early = await job(s.ana, s.g, {
        number: D,
        move: "claim",
        if_seq: 0,
      });
      expect(early.data.error.code).toBe("wrong_state");
      const cyClaim = await job(s.cy, s.g, {
        number: J,
        move: "claim",
        if_seq: 0,
      });
      expect(cyClaim.data.error.code).toBe("not_eligible");

      // The leader assigns J in chat, the old way: a message B will find
      // unread later, which the board never answers for.
      const said = await tool(s.lea, "post", {
        channel: s.g,
        body: "Ana, could you take the outline?",
      });
      expect(said.isError).toBe(false);

      // A claims J: its own row says submit or release by its lease.
      const c = await job(s.ana, s.g, { number: J, move: "claim", if_seq: 0 });
      expect(c.isError).toBe(false);
      const held = (await board(s.ana, s.g)).find((j) => j.number === J);
      expect(held).toMatchObject({
        state: "claimed",
        holder: s.ana.handle,
        you: "holder",
        seq: 1,
      });
      // The 30-minute lease J was posted with, give or take the clocks.
      const until = Date.parse(held?.lease_until ?? "");
      expect(until).toBeGreaterThan(Date.now() + 25 * 60_000);
      expect(until).toBeLessThan(Date.now() + 35 * 60_000);
      expect(await actionable(s.bo, s.g)).toEqual([]);
      // Neither B nor C is told when A's lease ends, though both see J held.
      for (const b of [s.bo, s.cy]) {
        const row = (await board(b, s.g)).find((j) => j.number === J);
        expect(row).toMatchObject({ state: "claimed", holder: s.ana.handle });
        expect(row?.lease_until).toBeUndefined();
      }

      // A submits X: nothing left for A to do; the leader reviews.
      const before = await wake(s.lea);
      const sub = await job(s.ana, s.g, {
        number: J,
        move: "submit",
        if_seq: 1,
        outputs: [X],
      });
      expect(sub.data.job.state).toBe("review");
      expect(await wake(s.lea)).toBe(before + 1);
      expect(await actionable(s.ana, s.g)).toEqual([]);
      expect(await actionable(s.lea, s.g)).toEqual([[J, "reviewer"]]);
      expect(await actionable(s.bo, s.g)).toEqual([]);
      expect(await actionable(s.cy, s.g)).toEqual([]);
      const twice = await job(s.ana, s.g, {
        number: J,
        move: "submit",
        if_seq: 2,
        outputs: [X],
      });
      expect(twice.data.error.code).toBe("wrong_state");
      // D still waits, with no inputs, until the leader accepts.
      const waiting = (await board(s.lea, s.g)).find((j) => j.number === D);
      expect(waiting).toMatchObject({ state: "waiting", inputs: 0 });

      // L accepts X: J done and held by no one; D ready, on X.
      const ok = await job(s.lea, s.g, {
        number: J,
        move: "accept",
        if_seq: 2,
      });
      expect(ok.data.job.state).toBe("done");
      const after = await board(s.lea, s.g);
      expect(after.map((j) => [j.number, j.state, j.holder])).toEqual([
        [J, "done", undefined],
        [D, "ready", undefined],
      ]);
      expect(after.find((j) => j.number === D)?.inputs).toBe(1);
      const dRead = await tool(s.lea, "read_channel", { channel: s.g, job: D });
      expect(dRead.data.job.inputs).toEqual([
        expect.objectContaining({ store: X.store, ref: X.ref }),
      ]);

      // B's cold read: the chat assignment is still there to read, but the
      // only thing B can act on is D; J is history with no claim on it.
      const chat = await tool(s.bo, "read_channel", { channel: s.g, after: 0 });
      expect(chat.isError).toBe(false);
      expect(JSON.stringify(chat.data.messages)).toContain(
        "could you take the outline",
      );
      const bJ = (await board(s.bo, s.g)).find((j) => j.number === J);
      expect(bJ).toMatchObject({ state: "done" });
      expect(bJ?.holder).toBeUndefined();
      expect(await actionable(s.bo, s.g)).toEqual([[D, "claimable"]]);
      expect(await actionable(s.cy, s.g)).toEqual([]);
      const old = await job(s.bo, s.g, { number: J, move: "claim", if_seq: 3 });
      expect(old.data.error.code).toBe("wrong_state");
      // B claims D and holds the only attempt, reading X as its input.
      const bClaim = await job(s.bo, s.g, {
        number: D,
        move: "claim",
        if_seq: 0,
      });
      expect(bClaim.data.job).toMatchObject({
        holder: s.bo.handle,
        seq: 1,
        attempt: 1,
      });
      expect(bClaim.data.job.inputs[0].ref).toBe(X.ref);
      expect(await actionable(s.ana, s.g)).toEqual([]);
    });

    it("case 3: an explicit release frees the job at once, a replay moves nothing, and the reason stays with the releaser", async () => {
      const s = await group();
      const { J, D } = await postBoth(s);
      const c = await job(s.ana, s.g, { number: J, move: "claim", if_seq: 0 });
      expect(c.isError).toBe(false);
      const before = await wake(s.lea);
      const rel = await job(s.ana, s.g, {
        number: J,
        move: "release",
        if_seq: 1,
        reason: "unavailable",
      });
      expect(rel.isError, JSON.stringify(rel.data)).toBe(false);
      // At once, not at the lease's end: ready, no holder, D still waits,
      // and A owes nothing on it.
      const now = await board(s.lea, s.g);
      expect(now.map((j) => [j.number, j.state, j.holder])).toEqual([
        [J, "ready", undefined],
        [D, "waiting", undefined],
      ]);
      expect(await wake(s.lea)).toBe(before + 1);
      expect((await board(s.ana, s.g)).find((j) => j.number === J)?.you).toBe(
        "claimable",
      );
      expect(await actionable(s.bo, s.g)).toEqual([[J, "claimable"]]);

      // The same release again: already, no second move or wake.
      const again = await job(s.ana, s.g, {
        number: J,
        move: "release",
        if_seq: 1,
        reason: "unavailable",
      });
      expect(again.data.already).toBe(true);
      expect((await board(s.lea, s.g)).find((j) => j.number === J)?.seq).toBe(
        2,
      );
      expect(await wake(s.lea)).toBe(before + 1);

      // A sees its own reason; L, B and C see none.
      const mine = await tool(s.ana, "read_channel", { channel: s.g, job: J });
      expect(JSON.stringify(mine.data.job.history)).toContain("unavailable");
      for (const b of [s.lea, s.bo, s.cy]) {
        const r = await tool(b, "read_channel", { channel: s.g, job: J });
        expect(JSON.stringify(r.data.job.history)).not.toContain("unavailable");
      }
      // B takes it straight away, on the job's next attempt.
      const bClaim = await job(s.bo, s.g, {
        number: J,
        move: "claim",
        if_seq: 2,
      });
      expect(bClaim.data.job).toMatchObject({
        holder: s.bo.handle,
        attempt: 2,
      });
      // A's old attempt can't move J now.
      const stale = await job(s.ana, s.g, {
        number: J,
        move: "submit",
        if_seq: 1,
        outputs: [X],
      });
      expect(stale.data.error.code).toBe("stale_job");
    });

    it.todo(
      "case 2: a silent holder's lease runs out, one dispatch pass offers the job once (needs a controlled clock on a running site, and offers and dispatch from B4b)",
    );
    it.todo(
      "case 4: a worker who can't read the exact pin gets its own blocker and another can claim (needs the access check from B4c)",
    );
    it.todo(
      "case 5: a day-late cold read says nothing is owed only on a complete read (needs catch_up's job rows, not built yet)",
    );
  });
}
