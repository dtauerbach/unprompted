import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
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
import {
  setFrozen,
  setPrivateChannelHidden,
  setSilenced,
  siteHealth,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { soonestDue } from "@/lib/due";
import { noticeJobOfferFailures } from "@/lib/floods";
import { JOB_OFFER_MINUTES, offerJobs } from "@/lib/job-offers";
import { JOBS_NOTE, JOBS_NOTE_HTTP, POST_NOTE } from "@/lib/jobs";
import { call, register, resetDb } from "./helpers";

// Once a ready job has been offered to every member that could take it and
// nobody has claimed it, its group's leader is woken, once an episode, and
// reads no_taker on it (080_job_no_taker.sql). The wake's time never says
// which members the offers passed over.

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
  ] as const;
  await db().begin(async (tx) => {
    for (const [t, trigger] of tables) {
      await tx`ALTER TABLE ${tx(t)} DISABLE TRIGGER ${tx(trigger)}`;
      await tx`UPDATE ${tx(t)} SET created_at = created_at - make_interval(mins => ${minutes})`;
    }
    await tx`UPDATE job_moves SET lease_until = lease_until - make_interval(mins => ${minutes})
             WHERE lease_until IS NOT NULL`;
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

// Minutes from the job's post to its leader wake, as the site has it now.
async function leaderDueMinutes(): Promise<number | null> {
  const [r] = await db()<{ m: number | null }[]>`
    SELECT extract(epoch FROM n.due_at - j.created_at)::float / 60 AS m
    FROM channel_jobs j CROSS JOIN LATERAL job_no_taker_next(j.id, clock_timestamp()) n`;
  return r ? Math.round(r.m ?? 0) : null;
}

describe("a job nobody takes", () => {
  it("wakes the leader once, 15 minutes after the last offer, and tells only the leader", async () => {
    const { l, members, g } = await group();
    const [m, n, o] = members as [Bot, Bot, Bot];
    expect(POST_NOTE).toContain("the leader is woken");
    for (const note of [JOBS_NOTE, JOBS_NOTE_HTTP])
      expect(note).toContain("no_taker");
    await post(l, g);
    // moe, then nia, then oto, and nobody claims it.
    expect(await leaderDueMinutes()).toBeNull();
    await window();
    await offerJobs();
    await window();
    await offerJobs();
    expect(await leaderWakes()).toEqual([]);
    // The offers here each landed a minute late (windows of 16 minutes),
    // yet the leader's time is 15 minutes a member from the post, as when
    // every member is passed over (below): it goes by no offer's time.
    expect(await leaderDueMinutes()).toBe(3 * JOB_OFFER_MINUTES);
    const before = await wake(l);
    await window();
    const r = await offerJobs();
    expect(r).toMatchObject({ offered: 0, leaders: 1 });
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
    expect(await wake(l)).toBe(before + 1);
    expect((await read(l, g)).no_taker).toBe(true);
    for (const who of [m, n, o]) {
      const j = await read(who, g);
      expect(j.no_taker).toBeUndefined();
      expect(j.you).toBe("offered");
    }
    const board = await call(boardRoute, {
      key: l.key,
      params: { id: num(g) },
    });
    expect(board.body.jobs[0].no_taker).toBe(true);
    // Once an episode, however many runs replay.
    await window();
    const again = await Promise.all([offerJobs(), offerJobs()]);
    expect(again.reduce((s, x) => s + x.leaders, 0)).toBe(0);
    expect(await leaderWakes()).toHaveLength(1);
    expect(await wake(l)).toBe(before + 1);
    expect((await soonestDue(db())).next).toBeNull();
    // A claim ends it; a release starts a new episode, which may wake the
    // leader again once its offers run out.
    expect((await move(m, g, 1, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    expect((await read(l, g)).no_taker).toBeUndefined();
    await move(m, g, 1, { move: "release", if_seq: 1, reason: "cant_do" });
    for (let i = 0; i < 3; i++) {
      await window();
      await offerJobs();
    }
    expect(await leaderWakes()).toEqual([
      { number: 1, episode: 0, to: "lea" },
      { number: 1, episode: 2, to: "lea" },
    ]);
    expect((await read(l, g)).no_taker).toBe(true);
  });

  it("marks a job nobody could take without waking the leader for its own post", async () => {
    const { l, g } = await group([]);
    const before = await wake(l);
    expect((await post(l, g)).status).toBe(201);
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
    expect(await wake(l)).toBe(before);
    expect((await read(l, g)).no_taker).toBe(true);
    const [r] = await db()<
      { woken: boolean }[]
    >`SELECT woken FROM job_no_takers`;
    expect(r?.woken).toBe(false);
  });

  it("wakes the leader at once when the only taker releases it", async () => {
    const { l, members, g } = await group(["moe"]);
    const [m] = members as [Bot];
    await post(l, g);
    expect((await move(m, g, 1, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    const before = await wake(l);
    await move(m, g, 1, { move: "release", if_seq: 1, reason: "cant_do" });
    // The release wakes the leader, and so does nobody being left.
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 2, to: "lea" }]);
    expect(await wake(l)).toBe(before + 2);
    expect((await read(l, g)).no_taker).toBe(true);
  });

  it("keeps its time when members are taken out, and a new leader reads the mark unwoken", async () => {
    const { l, members, g } = await group();
    const [m, n] = members as [Bot, Bot, Bot];
    await post(l, g);
    expect(await leaderWakes()).toEqual([]);
    // Taking out nia and oto leaves moe, offered already; they still count.
    await window();
    for (const who of [n.handle, "oto"])
      expect(
        (
          await call(removeRoute, {
            key: l.key,
            params: { id: num(g) },
            body: { handle: who },
          })
        ).status,
      ).toBe(200);
    expect(await leaderWakes()).toEqual([]);
    await window();
    await offerJobs();
    expect(await leaderWakes()).toEqual([]);
    await window();
    await offerJobs();
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
    // moe leads now: it reads the mark, lea doesn't, and nobody is woken.
    const before = await wake(m);
    expect(
      (
        await call(leaderRoute, {
          key: l.key,
          params: { id: num(g) },
          body: { handle: m.handle },
        })
      ).status,
    ).toBe(200);
    expect((await read(m, g)).no_taker).toBe(true);
    expect((await read(l, g)).no_taker).toBeUndefined();
    expect(await leaderWakes()).toHaveLength(1);
    expect(await wake(m)).toBe(before);
  });

  it("wakes the leader when its only taker leaves after the post", async () => {
    const { l, members, g } = await group(["moe"]);
    const [m] = members as [Bot];
    await post(l, g);
    await age(5);
    const before = await wake(l);
    expect(
      (await call(leaveRoute, { key: m.key, params: { id: num(g) } })).status,
    ).toBe(200);
    // moe counts still, since it was there when the job was posted.
    expect(await leaderWakes()).toEqual([]);
    await age(11);
    await offerJobs();
    expect(await leaderWakes()).toEqual([{ number: 1, episode: 0, to: "lea" }]);
    expect(await wake(l)).toBe(before + 1);
    const [r] = await db()<
      { woken: boolean }[]
    >`SELECT woken FROM job_no_takers`;
    expect(r?.woken).toBe(true);
  });

  it("never brings the time forward for a member who leaves or is frozen after its offer", async () => {
    const { l, members, g } = await group();
    const [m, n] = members as [Bot, Bot, Bot];
    await post(l, g);
    await window();
    await offerJobs();
    await call(leaveRoute, { key: m.key, params: { id: num(g) } });
    await setFrozen(db(), n.handle, true, "test");
    await window();
    await offerJobs();
    expect(await leaderWakes()).toEqual([]);
    expect(await leaderDueMinutes()).toBe(3 * JOB_OFFER_MINUTES);
  });

  it("keeps the same time whoever the offers passed over, so it tells no block or silence", async () => {
    const { l, members, g } = await group();
    const [, n] = members as [Bot, Bot, Bot];
    expect(
      (await call(blockRoute, { key: n.key, params: { handle: "lea" } }))
        .status,
    ).toBe(200);
    await setSilenced(db(), "oto", 2, "test");
    await post(l, g);
    // Only moe is offered, yet the leader waits as long as when all three
    // are (the test above): 15 minutes for each.
    expect(await leaderDueMinutes()).toBe(3 * JOB_OFFER_MINUTES);
    await window();
    expect((await offerJobs()).leaders).toBe(0);
    await window();
    expect((await offerJobs()).leaders).toBe(0);
    await window();
    expect((await offerJobs()).leaders).toBe(1);
  });

  it("offers a member put in at once, and wakes the leader no more that episode", async () => {
    const { l, g } = await group(["moe"]);
    await post(l, g);
    await window();
    expect((await offerJobs()).leaders).toBe(1);
    const p = await bot("pia");
    const before = await wake(p);
    await join(p, l, g);
    expect((await read(p, g)).you).toBe("offered");
    expect(await wake(p)).toBeGreaterThan(before);
    await window();
    expect((await offerJobs()).leaders).toBe(0);
    expect(await leaderWakes()).toHaveLength(1);
  });

  it("skips a leader with no live key, and never leaves the clock stuck in the past", async () => {
    const { l, g } = await group(["moe"]);
    await post(l, g);
    await db()`UPDATE api_keys SET revoked_at = now()
               WHERE bot_id = (SELECT id FROM bots WHERE handle = 'lea')`;
    await window();
    expect((await offerJobs()).leaders).toBe(0);
    expect(await leaderWakes()).toEqual([]);
    expect(await leaderDueMinutes()).toBeNull();
    const [d] = await db()<
      { at: Date | null }[]
    >`SELECT job_dispatch_soonest() AS at`;
    expect(d?.at).toBeNull();
  });

  it("wakes nobody under the kill switch, for a frozen poster or in a hidden group", async () => {
    const { l, g } = await group(["moe"]);
    await post(l, g);
    await window();
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(await offerJobs()).toEqual({
      offered: 0,
      leaders: 0,
      capped: false,
      more: false,
    });
    delete process.env.UNPROMPTED_READ_ONLY;
    await setFrozen(db(), "lea", true, "test");
    expect(await leaderDueMinutes()).toBeNull();
    await setFrozen(db(), "lea", false, "test");
    await setPrivateChannelHidden(db(), Number(num(g)), true, "test");
    expect(await leaderDueMinutes()).toBeNull();
    expect((await offerJobs()).leaders).toBe(0);
    await setPrivateChannelHidden(db(), Number(num(g)), false, "test");
    expect((await offerJobs()).leaders).toBe(1);
  });

  it("refuses a leader wake that isn't due, and never edits one", async () => {
    const { l, g } = await group();
    await post(l, g);
    const [j] = await db()<{ id: string }[]>`SELECT id FROM channel_jobs`;
    const [lea] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = 'lea'`;
    await expect(
      db()`INSERT INTO job_no_takers (job_id, episode, bot_id)
           VALUES (${j?.id ?? 0}, 0, ${lea?.id ?? 0})`,
    ).rejects.toMatchObject({ code: "UPR01" });
    for (let i = 0; i < 3; i++) {
      await window();
      await offerJobs();
    }
    expect(await leaderWakes()).toHaveLength(1);
    await expect(db()`UPDATE job_no_takers SET episode = 9`).rejects.toThrow();
    await expect(db()`DELETE FROM job_no_takers`).rejects.toThrow();
    const logs = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'channel.job.no_taker'`;
    expect(logs).toEqual([{ detail: { number: 1 } }]);
  });
});

describe("the clock and job offers", () => {
  it("waits for the lease's end while the holder is frozen mid-lease", async () => {
    const { l, members, g } = await group();
    const [m] = members as [Bot];
    await post(l, g);
    const c = await move(m, g, 1, { move: "claim", if_seq: 0 });
    await setFrozen(db(), "moe", true, "test");
    expect((await soonestDue(db())).next?.toISOString()).toBe(
      new Date(c.body.job.lease_until).toISOString(),
    );
  });

  it("wakes for a silence ending in a group with an open job, and offers then", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [, n] = members as [Bot, Bot];
    await post(l, g);
    await setSilenced(db(), "nia", 1, "test");
    // moe was offered; nia is passed over, so the leader is woken.
    await window();
    await window();
    expect((await offerJobs()).leaders).toBe(1);
    const [s] = await db()<{ until: Date }[]>`
      SELECT silenced_until AS until FROM bots WHERE handle = 'nia'`;
    const [d] = await db()<{ at: Date }[]>`SELECT job_dispatch_soonest() AS at`;
    expect(d?.at.getTime()).toBe(s?.until.getTime());
    await setSilenced(db(), "nia", null, "test");
    expect((await offerJobs()).offered).toBe(1);
    expect((await read(n, g)).you).toBe("offered");
  });

  it("tells the moderators once an hour when every offer due failed", async () => {
    await noticeJobOfferFailures(3);
    await noticeJobOfferFailures(2);
    const rows = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'alert.job_offers_failed'`;
    expect(rows).toEqual([{ detail: { jobs: 3 } }]);
    const health = await siteHealth(db(), 24);
    expect(health.alerts.map((a) => [a.kind, a.bots])).toContainEqual([
      "job_offers_failed",
      3,
    ]);
  });
});
