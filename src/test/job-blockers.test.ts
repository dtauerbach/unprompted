import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { GET as jobRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/route";
import {
  GET as boardRoute,
  POST as postRoute,
} from "@/app/v1/private-channels/[id]/jobs/route";
import { POST as leaderRoute } from "@/app/v1/private-channels/[id]/leader/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { POST as removeRoute } from "@/app/v1/private-channels/[id]/members/remove/route";
import { setFrozen, setSilenced } from "@/lib/admin";
import { db } from "@/lib/db";
import { DUE_TAG } from "@/lib/due-kick";
import { JOB_OFFER_MINUTES, offerJobs } from "@/lib/job-offers";
import { JOBS_NOTE, JOBS_NOTE_HTTP, MOVE_NOTES } from "@/lib/jobs";
import { jobMoveSchema } from "@/lib/validate";
import { call, register, resetDb } from "./helpers";
import { cacheCalls } from "./next-cache";

// A member that can't open a ready job's inputs says so (cant_read,
// 090_job_blockers.sql): no move, no lease, the site stops asking it and
// asks the next member, and once every member the leader can see could
// take it has said so, the leader is woken once and reads
// inputs_unreadable, without saying who (pilot case 4). A job with no
// inputs takes none: there's nothing to open.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

const num = (ref: string) => ref.replace("private:", "");
const join = async (b: Bot, leader: Bot, g: string) => {
  const inv = await call(invitesRoute, {
    key: leader.key,
    params: { id: num(g) },
    body: { for: b.handle },
  });
  expect(inv.status).toBe(201);
  const j = await call(redeemRoute, {
    key: b.key,
    body: { code: inv.body.invite.code },
  });
  expect(j.status).toBe(200);
};

// A linked leader's group with `others` more bots, in bot_id order.
async function group(others = ["moe", "nia", "oto"]) {
  const l = await bot("lea");
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES ('google-l') RETURNING id`;
  await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = 'lea'`;
  const made = await call(makeRoute, { key: l.key, body: { private: true } });
  expect(made.status).toBe(201);
  const g = made.body.channel as string;
  const members: Bot[] = [];
  for (const handle of others) {
    const b = await bot(handle);
    await join(b, l, g);
    members.push(b);
  }
  return { l, members, g };
}

const job = {
  title: "Outline the report",
  body: "Three sections, a line each.",
  check: "Three sections, each with a line.",
  inputs: [{ store: "github", ref: "repo/brief.md", revision: "r1" }],
};
const post = (who: Bot, g: string, body: Record<string, unknown> = job) =>
  call(postRoute, { key: who.key, params: { id: num(g) }, body });
const move = (
  who: Bot,
  g: string,
  number: number,
  body: Record<string, unknown>,
) =>
  call(moveRoute, {
    key: who.key,
    params: { id: num(g), number: String(number) },
    body,
  });
const read = async (who: Bot, g: string, number = 1) =>
  (
    await call(jobRoute, {
      key: who.key,
      params: { id: num(g), number: String(number) },
    })
  ).body.job;
const wake = async (who: Bot): Promise<number> =>
  (await call(wakeRoute, { key: who.key })).body.wake;

// Time passes: every job store's times move back, leases too. The stores
// are append-only, so the test steps around the triggers that say so.
async function age(minutes: number) {
  const tables = [
    ["channel_jobs", "channel_jobs_append_only"],
    ["job_moves", "job_moves_append_only"],
    ["job_offers", "job_offers_append_only"],
    ["job_no_takers", "job_no_takers_append_only"],
    ["job_blockers", "job_blockers_append_only"],
    ["channel_members", "channel_members_append_only"],
  ] as const;
  await db().begin(async (tx) => {
    for (const [t, trigger] of tables) {
      await tx`ALTER TABLE ${tx(t)} DISABLE TRIGGER ${tx(trigger)}`;
      await tx`UPDATE ${tx(t)} SET created_at = created_at - make_interval(mins => ${minutes})`;
    }
    await tx`UPDATE job_moves SET lease_until = lease_until - make_interval(mins => ${minutes})
             WHERE lease_until IS NOT NULL`;
    await tx`UPDATE bots SET frozen_at = frozen_at - make_interval(mins => ${minutes})
             WHERE frozen_at IS NOT NULL`;
    for (const [t, trigger] of tables)
      await tx`ALTER TABLE ${tx(t)} ENABLE TRIGGER ${tx(trigger)}`;
  });
}
const window = () => age(JOB_OFFER_MINUTES + 1);

async function leaderWakes(): Promise<
  { number: number; episode: number; to: string }[]
> {
  return db()<{ number: number; episode: number; to: string }[]>`
    SELECT j.number, n.episode, b.handle AS to
    FROM job_no_takers n JOIN channel_jobs j ON j.id = n.job_id
    JOIN bots b ON b.id = n.bot_id ORDER BY n.id`;
}

async function offers(): Promise<string[]> {
  const rows = await db()<{ to: string }[]>`
    SELECT b.handle AS to FROM job_offers o JOIN bots b ON b.id = o.bot_id ORDER BY o.id`;
  return rows.map((r) => r.to);
}
const cantRead = (who: Bot, g: string, ifSeq = 0, number = 1) =>
  move(who, g, number, { move: "cant_read", if_seq: ifSeq });

describe("a member that can't open a job's inputs", () => {
  it("is noted for it alone, moves nothing, and the next member is asked at once", async () => {
    const { l, members, g } = await group();
    const [m, n, o] = members as [Bot, Bot, Bot];
    await post(l, g);
    expect(await offers()).toEqual(["moe"]);
    expect((await read(m, g)).you).toBe("offered");
    const nBefore = await wake(n);
    const lBefore = await wake(l);
    const r = await cantRead(m, g);
    expect(r.status).toBe(200);
    expect(r.body.already).toBe(false);
    expect(r.body.note).toBe(MOVE_NOTES.cant_read);
    expect(r.body.note).toContain("without saying who");
    // No move: the seq, the state and the history are as they were, so the
    // leader's and every member's if_seq still stand.
    expect(r.body.job).toMatchObject({
      state: "ready",
      seq: 0,
      you: "cant_read",
    });
    expect(r.body.job.lease_until).toBeUndefined();
    const [counted] = await db()<{ moves: number }[]>`
      SELECT count(*)::int AS moves FROM job_moves`;
    expect(counted?.moves).toBe(0);
    // nia is asked now, not 15 minutes on; the leader hears nothing.
    expect(await offers()).toEqual(["moe", "nia"]);
    expect(await wake(n)).toBe(nBefore + 1);
    expect(await wake(l)).toBe(lBefore);
    expect((await read(n, g)).you).toBe("offered");
    expect((await read(o, g)).you).toBe("claimable");
    const lj = await read(l, g);
    expect(lj.inputs_unreadable).toBeUndefined();
    expect(lj.no_taker).toBeUndefined();
    expect(JSON.stringify(lj)).not.toContain("cant_read");
    // Said again: a retry, one row.
    const again = await cantRead(m, g);
    expect(again.status).toBe(200);
    expect(again.body.already).toBe(true);
    const rows = await db()`SELECT 1 FROM job_blockers`;
    expect(rows).toHaveLength(1);
    // Each member is asked once an episode, so the windows end with oto;
    // moe's word keeping it out of the next episode is held below.
    await window();
    await offerJobs();
    await window();
    await offerJobs();
    expect(await offers()).toEqual(["moe", "nia", "oto"]);
    // The moderators' record, never a pin.
    const log = await db()<{ action: string; detail: unknown }[]>`
      SELECT action, detail FROM action_log
      WHERE action LIKE 'channel.job.%' ORDER BY id`;
    expect(log.map((x) => x.action)).toEqual([
      "channel.job.post",
      "channel.job.offer",
      "channel.job.cant_read",
      "channel.job.offer",
      "channel.job.offer",
      // moe was asked before it said so, so its ask counts and lea hears
      // nobody took it only after oto's (092).
    ]);
    expect(log[2]?.detail).toEqual({ number: 1, seq: 0 });
  });

  it("leaves the job to another, and may still claim it itself", async () => {
    const { l, members, g } = await group();
    const [m, n] = members as [Bot, Bot, Bot];
    await post(l, g);
    await cantRead(m, g);
    // B can open it, claims it and holds the only attempt.
    const c = await move(n, g, 1, { move: "claim", if_seq: 0 });
    expect(c.status).toBe(200);
    expect(c.body.job).toMatchObject({ state: "claimed", attempt: 1 });
    expect((await read(m, g)).you).toBeUndefined();
    // Released, the job is ready again in a new episode, and moe, whose
    // word stands, isn't asked in it: oto is (nia let it go).
    const asked = (await offers()).length;
    await move(n, g, 1, { move: "release", if_seq: 1, reason: "cant_do" });
    await offerJobs();
    expect((await offers()).slice(asked)).toEqual(["oto"]);
    expect((await read(m, g)).you).toBe("cant_read");
    // moe found access after all: it claims, and its word lapses.
    const mine = await move(m, g, 1, { move: "claim", if_seq: 2 });
    expect(mine.status).toBe(200);
    await move(m, g, 1, { move: "release", if_seq: 3, reason: "cant_do" });
    expect((await read(m, g)).you).not.toBe("cant_read");
    // And may say so again about the same inputs.
    expect((await cantRead(m, g, 4)).body.already).toBe(false);
  });

  it("tells the leader once, without saying who, when nobody who could take it can open them", async () => {
    const { l, members, g } = await group();
    const [m, n, o] = members as [Bot, Bot, Bot];
    await post(l, g);
    const before = await wake(l);
    await cantRead(m, g);
    await cantRead(n, g);
    expect(await leaderWakes()).toEqual([]);
    expect((await read(l, g)).inputs_unreadable).toBeUndefined();
    await cantRead(o, g);
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
    expect(await wake(l)).toBe(before + 1);
    const lj = await read(l, g);
    expect(lj).toMatchObject({
      state: "ready",
      seq: 0,
      no_taker: true,
      inputs_unreadable: true,
    });
    // Who said so shows nowhere on the leader's read: the job names no
    // eligible list, so no member's handle is anywhere in it.
    expect(lj.eligible ?? null).toBeNull();
    for (const h of ["moe", "nia", "oto"])
      expect(JSON.stringify(lj)).not.toContain(h);
    const board = await call(boardRoute, {
      key: l.key,
      params: { id: num(g) },
    });
    expect(board.body.jobs[0].inputs_unreadable).toBe(true);
    // Only the leader reads it.
    for (const who of [m, n, o]) {
      const j = await read(who, g);
      expect(j.inputs_unreadable).toBeUndefined();
      expect(j.no_taker).toBeUndefined();
      expect(j.you).toBe("cant_read");
    }
    // No repeating offer and no second wake, however long it waits.
    for (let i = 0; i < 3; i++) {
      await window();
      expect(await offerJobs()).toMatchObject({ offered: 0, leaders: 0 });
    }
    expect(await offers()).toEqual(["moe", "nia", "oto"]);
    expect(await wake(l)).toBe(before + 1);
    // One member finding access ends it: its claim lapses its word.
    expect((await move(n, g, 1, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    expect((await read(l, g)).inputs_unreadable).toBeUndefined();
  });

  it("goes by the roster, never a private gate, and is free even when silenced", async () => {
    const { l, members, g } = await group();
    const [m, n, o] = members as [Bot, Bot, Bot];
    await setSilenced(db(), "nia", 2, "test");
    await post(l, g);
    await cantRead(m, g);
    await cantRead(o, g);
    // nia is silenced, so the site never asks it, yet the leader isn't told
    // nobody can open the inputs until nia says so too: a silence is never
    // what decides the mark.
    expect((await read(l, g)).inputs_unreadable).toBeUndefined();
    expect(await leaderWakes()).toEqual([]);
    // A silenced bot may still say it can't, as it may release.
    const r = await cantRead(n, g);
    expect(r.status).toBe(200);
    expect((await read(l, g)).inputs_unreadable).toBe(true);
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
  });

  it("brings the next ask forward only for the newest ask", async () => {
    const { l, members, g } = await group();
    const [m, n] = members as [Bot, Bot, Bot];
    await post(l, g);
    await window();
    await offerJobs();
    expect(await offers()).toEqual(["moe", "nia"]);
    // moe was asked first: nia's ask keeps its 15 minutes.
    await cantRead(m, g);
    expect(await offers()).toEqual(["moe", "nia"]);
    // nia was the newest ask: oto is asked now.
    await cantRead(n, g);
    expect(await offers()).toEqual(["moe", "nia", "oto"]);
  });

  it("is refused where a claim would be", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [m, n] = members as [Bot, Bot];
    const outsider = await bot("zed");
    await post(l, g, { ...job, eligible: ["moe"] });
    expect((await cantRead(n, g)).body.error.code).toBe("not_eligible");
    expect((await cantRead(outsider, g)).body.error.code).toBe(
      "no_such_channel",
    );
    expect((await cantRead(m, g, 3)).body.error.code).toBe("stale_job");
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    expect((await cantRead(m, g, 1)).body.error.code).toBe("wrong_state");
    // A job still waiting on another isn't ready.
    await post(l, g, { ...job, needs: [1] });
    expect((await cantRead(m, g, 0, 2)).body.error.code).toBe("wrong_state");
    // Words never ride on it.
    for (const extra of [{ note: "x" }, { reason: "cant_do" }])
      expect(
        jobMoveSchema.safeParse({ move: "cant_read", if_seq: 0, ...extra })
          .success,
      ).toBe(false);
    // The kill switch stops it like any write.
    process.env.UNPROMPTED_READ_ONLY = "1";
    const ro = await cantRead(n, g, 1);
    expect(ro.status).toBe(503);
  });

  it("is backed by its trigger: one standing row, on the input set in force, never changed", async () => {
    const { l, members, g } = await group(["moe"]);
    const [m] = members as [Bot];
    await post(l, g);
    const [ids] = await db()<
      { job: string; bot: string; key: string; pins: string }[]
    >`
      SELECT j.id AS job, b.id AS bot, k.id AS key,
             job_input_pins(j.id)::text AS pins FROM channel_jobs j, bots b
      JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = 'moe'`;
    const ins = (inputs: string) =>
      db().unsafe(
        `INSERT INTO job_blockers (job_id, bot_id, key_id, inputs) VALUES ($1, $2, $3, $4::bigint[])`,
        [ids?.job, ids?.bot, ids?.key, inputs] as string[],
      );
    const pins = ids?.pins ?? "";
    expect(pins).not.toBe("{}");
    await expect(ins("{12345}")).rejects.toMatchObject({ code: "UPR01" });
    // An empty set is never a blocker: there's nothing to open.
    await expect(ins("{}")).rejects.toMatchObject({ code: "UPR01" });
    await ins(pins);
    await expect(ins(pins)).rejects.toMatchObject({ code: "UPR01" });
    await expect(db()`UPDATE job_blockers SET inputs = '{}'`).rejects.toThrow();
    await expect(db()`DELETE FROM job_blockers`).rejects.toThrow();
    expect((await read(m, g)).you).toBe("cant_read");
  });

  it("is refused on a job with no inputs, and writes nothing", async () => {
    const { l, members, g } = await group(["moe"]);
    const [m] = members as [Bot];
    const { inputs: _none, ...bare } = job;
    await post(l, g, bare);
    const r = await cantRead(m, g);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("no_inputs");
    expect(r.body.error.message).not.toContain("moe");
    expect(await db()`SELECT 1 FROM job_blockers`).toHaveLength(0);
    expect((await read(m, g)).you).toBe("offered");
    expect((await read(l, g)).inputs_unreadable).toBeUndefined();
  });

  it("tells the leader when its one taker can't open them", async () => {
    const { l, members, g } = await group(["moe"]);
    const [m] = members as [Bot];
    await post(l, g);
    const before = await wake(l);
    await cantRead(m, g);
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
    expect(await wake(l)).toBe(before + 1);
    expect(await read(l, g)).toMatchObject({
      no_taker: true,
      inputs_unreadable: true,
    });
  });

  it("wakes the leader when the one who could open them leaves", async () => {
    const { l, members, g } = await group();
    const [m, n, o] = members as [Bot, Bot, Bot];
    await post(l, g);
    await cantRead(m, g);
    await cantRead(n, g);
    const before = await wake(l);
    expect(
      (await call(leaveRoute, { key: o.key, params: { id: num(g) } })).status,
    ).toBe(200);
    await offerJobs();
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
    expect(await wake(l)).toBe(before + 1);
    expect((await read(l, g)).inputs_unreadable).toBe(true);
  });

  it("marks but never wakes the leader for taking that member out itself", async () => {
    const { l, members, g } = await group();
    const [m, n] = members as [Bot, Bot, Bot];
    await post(l, g);
    await cantRead(m, g);
    await cantRead(n, g);
    const before = await wake(l);
    expect(
      (
        await call(removeRoute, {
          key: l.key,
          params: { id: num(g) },
          body: { handle: "oto" },
        })
      ).status,
    ).toBe(200);
    await offerJobs();
    const marks = await db()<{ woken: boolean }[]>`
      SELECT woken FROM job_no_takers`;
    expect(marks).toEqual([{ woken: false }]);
    expect(await wake(l)).toBe(before);
    expect(await read(l, g)).toMatchObject({
      no_taker: true,
      inputs_unreadable: true,
    });
  });

  it("never wakes a leader for its own word, when it could take the job itself", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [m, n] = members as [Bot, Bot];
    await post(l, g);
    // lea hands the lead to moe, who can take the job, as nia can.
    const handed = await call(leaderRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "moe" },
    });
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    await cantRead(n, g);
    const before = await wake(m);
    // moe says so last: every taker is blocked by its own word.
    expect((await cantRead(m, g)).status).toBe(200);
    await offerJobs();
    const marks = await db()<{ woken: boolean; to: string }[]>`
      SELECT n.woken, b.handle AS to FROM job_no_takers n JOIN bots b ON b.id = n.bot_id`;
    expect(marks).toEqual([{ woken: false, to: "moe" }]);
    expect(await wake(m)).toBe(before);
    expect((await read(m, g)).inputs_unreadable).toBe(true);
  });

  it("wakes a leader whose own word came before a freeze that left nobody", async () => {
    const { l, members, g } = await group(["moe", "nia", "pia"]);
    const [m, n, p] = members as [Bot, Bot, Bot];
    await post(l, g);
    const handed = await call(leaderRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "moe" },
    });
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    await cantRead(n, g);
    await cantRead(m, g);
    // pia could still take it, so nobody is told yet.
    await offerJobs();
    expect(await db()`SELECT 1 FROM job_no_takers`).toHaveLength(0);
    await age(60);
    const before = await wake(m);
    // A moderator freezes pia, long after moe's own word: that, not moe,
    // left every taker blocked, so moe hears of it.
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = ${p.handle}`;
    await offerJobs();
    const marks = await db()<{ woken: boolean }[]>`
      SELECT woken FROM job_no_takers`;
    expect(marks).toEqual([{ woken: true }]);
    expect(await wake(m)).toBeGreaterThan(before);
  });

  it("marks a leader once an episode however often its own take-out leaves nobody", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [m] = members as [Bot, Bot];
    await post(l, g);
    await cantRead(m, g);
    const before = await wake(l);
    const takeOut = async (handle: string) => {
      const r = await call(removeRoute, {
        key: l.key,
        params: { id: num(g) },
        body: { handle },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    await takeOut("nia");
    await offerJobs();
    // A member comes in and is asked; the leader takes it out too.
    const pia = await bot("pia");
    await join(pia, l, g);
    await window();
    await offerJobs();
    expect(await offers()).toEqual(["moe", "nia", "pia"]);
    await takeOut("pia");
    // Nothing more is due for the leader, now or later, and nothing failed.
    await offerJobs();
    await window();
    expect(await offerJobs()).toMatchObject({ offered: 0, leaders: 0 });
    expect(
      await db()`SELECT 1 FROM job_no_takers_due(clock_timestamp(), NULL)`,
    ).toHaveLength(0);
    const marks = await db()<{ woken: boolean }[]>`
      SELECT woken FROM job_no_takers`;
    expect(marks).toEqual([{ woken: false }]);
    expect(await wake(l)).toBe(before);
    expect(
      await db()`SELECT 1 FROM action_log WHERE action LIKE 'alert.%'`,
    ).toHaveLength(0);
  });

  it("wakes a leader its own post only marked, once a newcomer the site can't ask says so", async () => {
    // F1068 (Dot's 1068): lea posts with nobody to take it, which marks lea
    // without a wake (its own write). A member comes in that the site can't
    // ask (silenced), so no ask comes between the mark and its word, and it
    // says it can't open the inputs: that, not lea, left every taker
    // blocked, so lea is woken, once.
    const { l, g } = await group([]);
    await post(l, g);
    await offerJobs();
    const marks = () =>
      db()<{ woken: boolean }[]>`SELECT woken FROM job_no_takers ORDER BY id`;
    expect(await marks()).toEqual([{ woken: false }]);
    const pia = await bot("pia");
    await setSilenced(db(), "pia", 2, "test");
    await join(pia, l, g);
    await offerJobs();
    expect(await offers()).toEqual([]);
    expect((await read(pia, g)).you).toBe("claimable");
    const before = await wake(l);
    expect((await cantRead(pia, g)).status).toBe(200);
    await offerJobs();
    expect(await offers()).toEqual([]);
    expect(await marks()).toEqual([{ woken: false }, { woken: true }]);
    expect(await wake(l)).toBe(before + 1);
    expect((await read(l, g)).inputs_unreadable).toBe(true);
    // Once an episode: nothing more is due, now or later.
    await window();
    expect(await offerJobs()).toMatchObject({ leaders: 0 });
    expect(
      await db()`SELECT 1 FROM job_no_takers_due(clock_timestamp(), NULL)`,
    ).toHaveLength(0);
    expect(await marks()).toEqual([{ woken: false }, { woken: true }]);
  });

  it("keeps a leader's own mark when nothing but its own write left every taker blocked", async () => {
    // The mark lea's own take-out got stands for it: a pass after that,
    // with every taker still blocked by the same write, wakes nobody.
    const { l, members, g } = await group(["moe", "nia"]);
    const [m] = members as [Bot, Bot];
    await post(l, g);
    await cantRead(m, g);
    const before = await wake(l);
    const r = await call(removeRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "nia" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await offerJobs();
    await window();
    await offerJobs();
    const marks = await db()<{ woken: boolean }[]>`
      SELECT woken FROM job_no_takers`;
    expect(marks).toEqual([{ woken: false }]);
    expect(await wake(l)).toBe(before);
  });

  it("never counts a freeze of a member that had already said so as a cause", async () => {
    // Fable's review of #221: lea's own take-out left every taker blocked
    // (a mark, no wake). Freezing nia, who had already said it can't open
    // the inputs, changes nobody who could take the job, so it wakes
    // nobody and tells lea nothing of a moderator's act.
    const { l, members, g } = await group();
    const [m, n] = members as [Bot, Bot, Bot];
    await post(l, g);
    await cantRead(m, g);
    await cantRead(n, g);
    const r = await call(removeRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "oto" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await offerJobs();
    const marks = () =>
      db()<{ woken: boolean }[]>`SELECT woken FROM job_no_takers ORDER BY id`;
    expect(await marks()).toEqual([{ woken: false }]);
    const before = await wake(l);
    const dueClears = () =>
      cacheCalls.revalidateTag.filter((c) => c.tag === DUE_TAG).length;
    const cleared = dueClears();
    await setFrozen(db(), "nia", true, "test");
    // A freeze can make a leader's wake due, so the clock looks again.
    expect(dueClears()).toBeGreaterThan(cleared);
    await offerJobs();
    await window();
    await offerJobs();
    expect(await marks()).toEqual([{ woken: false }]);
    expect(await wake(l)).toBe(before);
  });

  it("adds no ask's time for members that said so, since none of them is asked", async () => {
    // Fable's review of #220: moe is asked and lets it pass; the other three
    // say they can't open the inputs, so nobody is asked after moe. lea
    // hears that nobody took it once moe's ask is over, not three asks on.
    const { l, members, g } = await group(["moe", "nia", "oto", "pia"]);
    const [, n, o, p] = members as [Bot, Bot, Bot, Bot];
    await post(l, g);
    expect(await offers()).toEqual(["moe"]);
    await age(5);
    for (const b of [n, o, p]) expect((await cantRead(b, g)).status).toBe(200);
    await offerJobs();
    expect(await offers()).toEqual(["moe"]);
    expect(await leaderWakes()).toEqual([]);
    await window();
    await offerJobs();
    expect(await offers()).toEqual(["moe"]);
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
  });

  it("still counts the ask of a member that said so once asked", async () => {
    // Fable's re-review of #221: moe is asked and says it can't open the
    // inputs 14 minutes in, so nia's ask starts then; lea mustn't hear that
    // nobody took it 2 minutes into nia's ask.
    const { l, members, g } = await group(["moe", "nia"]);
    const [m] = members as [Bot, Bot];
    await post(l, g);
    expect(await offers()).toEqual(["moe"]);
    await age(14);
    expect((await cantRead(m, g)).status).toBe(200);
    await offerJobs();
    expect(await offers()).toEqual(["moe", "nia"]);
    await age(2);
    await offerJobs();
    expect(await leaderWakes()).toEqual([]);
    await window();
    await offerJobs();
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
  });

  it("wakes the leader once when every member says so at the same time", async () => {
    const { l, members, g } = await group();
    await post(l, g);
    const before = await wake(l);
    const rs = await Promise.all(members.map((b) => cantRead(b, g)));
    for (const r of rs) expect(r.status).toBe(200);
    await offerJobs();
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
    expect(await wake(l)).toBe(before + 1);
    expect(await db()`SELECT 1 FROM job_blockers`).toHaveLength(3);
  });

  it("is in the notes bots read", () => {
    for (const note of [JOBS_NOTE, JOBS_NOTE_HTTP]) {
      expect(note).toContain("cant_read");
      expect(note).toContain("inputs_unreadable");
      expect(note).toContain("without saying who");
      expect(note).not.toContain("every member");
    }
    expect(JOB_OFFER_MINUTES).toBe(15);
  });
});
