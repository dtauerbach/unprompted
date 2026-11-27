import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { GET as jobRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/route";
import { POST as postRoute } from "@/app/v1/private-channels/[id]/jobs/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { POST as removeRoute } from "@/app/v1/private-channels/[id]/members/remove/route";
import { setFrozen, setSilenced } from "@/lib/admin";
import { db } from "@/lib/db";
import { JOB_OFFER_MINUTES, offerJobs } from "@/lib/job-offers";
import { call, register, resetDb } from "./helpers";

// Fable's review of 090_job_blockers.sql (#220) after it merged, re-checked
// on top of 092: each case fails on 092 and passes with 095.

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
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const j = await call(redeemRoute, {
    key: b.key,
    body: { code: inv.body.invite.code },
  });
  expect(j.status, JSON.stringify(j.body)).toBe(200);
};

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
const cantRead = (who: Bot, g: string, ifSeq = 0, number = 1) =>
  move(who, g, number, { move: "cant_read", if_seq: ifSeq });

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
    await tx`ALTER TABLE bot_freeze_changes DISABLE TRIGGER bot_freeze_changes_append_only`;
    await tx`UPDATE bot_freeze_changes SET at = at - make_interval(mins => ${minutes})`;
    await tx`ALTER TABLE bot_freeze_changes ENABLE TRIGGER bot_freeze_changes_append_only`;
    for (const [t, trigger] of tables)
      await tx`ALTER TABLE ${tx(t)} ENABLE TRIGGER ${tx(trigger)}`;
  });
}
const window = () => age(JOB_OFFER_MINUTES + 1);

const marks = () =>
  db()<{ episode: number; woken: boolean; reason: string }[]>`
    SELECT episode, woken, reason FROM job_no_takers ORDER BY id`;
async function offers(): Promise<string[]> {
  const rows = await db()<{ to: string }[]>`
    SELECT b.handle AS to FROM job_offers o JOIN bots b ON b.id = o.bot_id ORDER BY o.id`;
  return rows.map((r) => r.to);
}

describe("job blockers after the review of #220", () => {
  // Finding 1, another gate than 092's own test (silenced): a newcomer that
  // blocked the poster is never asked, then says cant_read.
  it("wakes a leader its own post only marked, once a newcomer that blocked it says cant_read", async () => {
    const { l, g } = await group([]);
    await post(l, g);
    await offerJobs();
    expect(await marks()).toEqual([
      { episode: 0, woken: false, reason: "no_taker" },
    ]);
    const pia = await bot("pia");
    // Silenced only so the join's own pass doesn't ask it; then it blocks
    // the poster and the silence ends, so the block alone keeps it unasked.
    await setSilenced(db(), "pia", 2, "test");
    await join(pia, l, g);
    const b = await call(blockRoute, {
      key: pia.key,
      params: { handle: "lea" },
    });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    await db()`UPDATE bots SET silenced_until = NULL WHERE handle = 'pia'`;
    await offerJobs();
    expect(await offers()).toEqual([]);
    const before = await wake(l);
    expect((await cantRead(pia, g)).status).toBe(200);
    await offerJobs();
    expect(await marks()).toEqual([
      { episode: 0, woken: false, reason: "no_taker" },
      { episode: 0, woken: true, reason: "inputs_unreadable" },
    ]);
    expect(await wake(l)).toBe(before + 1);
    expect((await read(l, g)).inputs_unreadable).toBe(true);
  });

  // Finding 2 (a design question): the leader heard no_taker at the end of
  // the asks; afterwards every member says it can't open the inputs. The
  // leader reads inputs_unreadable, but is it woken for it?
  it("wakes the leader for inputs_unreadable after an ordinary no_taker wake in the same episode", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [m, n] = members as [Bot, Bot];
    await post(l, g);
    await window();
    await offerJobs();
    await window();
    await offerJobs();
    expect(await marks()).toEqual([
      { episode: 0, woken: true, reason: "no_taker" },
    ]);
    expect((await read(l, g)).no_taker).toBe(true);
    const before = await wake(l);
    expect((await cantRead(m, g)).status).toBe(200);
    expect((await cantRead(n, g)).status).toBe(200);
    await offerJobs();
    expect((await read(l, g)).inputs_unreadable).toBe(true);
    // Correct (per the review): the new fact reaches the leader.
    expect(await wake(l)).toBe(before + 1);
  });

  // Finding 3: the leader's own claim, lapsed, is the episode's move (lby),
  // so 092's cause query names the leader and only marks it.
  it("wakes a leader when its own lease runs out with every other taker blocked", async () => {
    const { l, members, g } = await group(["moe"]);
    const [m] = members as [Bot];
    await post(l, g);
    expect((await cantRead(m, g)).status).toBe(200);
    // Episode 0: moe alone could take it and can't open it; lea is woken.
    expect(await marks()).toEqual([
      { episode: 0, woken: true, reason: "inputs_unreadable" },
    ]);
    const c = await move(l, g, 1, { move: "claim", if_seq: 0 });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const before = await wake(l);
    await age(241);
    await offerJobs();
    // Episode 1 began when lea's lease ran out, which isn't lea's write: a
    // lapse wakes the leader on the ordinary path (lk = 'claim', gone null).
    expect((await read(l, g)).state).toBe("ready");
    expect((await read(l, g)).inputs_unreadable).toBe(true);
    expect(await marks()).toEqual([
      { episode: 0, woken: true, reason: "inputs_unreadable" },
      { episode: 1, woken: true, reason: "inputs_unreadable" },
    ]);
    expect(await wake(l)).toBe(before + 1);
  });

  // Finding 4: the cause is judged when the pass runs. A freeze from the
  // command line (no pass) leaves every taker blocked; before any pass, the
  // leader takes the frozen bot out, a write that changes nobody who could
  // take the job. The pass then names the leader's take-out the cause.
  it("judges the cause as of when every taker became blocked, not the pass", async () => {
    const { l, members, g } = await group();
    const [m, n] = members as [Bot, Bot, Bot];
    await post(l, g);
    await cantRead(m, g);
    await cantRead(n, g);
    expect(await marks()).toEqual([]);
    await age(60);
    // A lever pulled from the command line: no pass runs.
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'oto'`;
    const before = await wake(l);
    const r = await call(removeRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "oto" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await offerJobs();
    // The freeze, not lea's take-out of a frozen bot, left nobody.
    expect(await marks()).toEqual([
      { episode: 0, woken: true, reason: "inputs_unreadable" },
    ]);
    expect(await wake(l)).toBe(before + 1);
  });

  // Finding 5: a blocker outlived the membership it was said under.
  it("ends a member's cant_read when it leaves and comes back", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [, n] = members as [Bot, Bot];
    await post(l, g);
    expect(await offers()).toEqual(["moe"]);
    expect((await cantRead(n, g)).status).toBe(200);
    expect(
      (await call(leaveRoute, { key: n.key, params: { id: num(g) } })).status,
    ).toBe(200);
    await join(n, l, g);
    expect((await read(n, g)).you).not.toBe("cant_read");
    await window();
    await offerJobs();
    expect(await offers()).toEqual(["moe", "nia"]);
  });

  // A key isn't a roster fact, so a new one leaves the word standing (the
  // leader's flag goes by roster facts only, 090) and the bot may still
  // claim the job.
  it("keeps a member's cant_read through a new key", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [m, n] = members as [Bot, Bot];
    await post(l, g);
    expect((await cantRead(m, g)).status).toBe(200);
    expect((await cantRead(n, g)).status).toBe(200);
    expect((await read(l, g)).inputs_unreadable).toBe(true);
    expect(await offers()).toEqual(["moe", "nia"]);
    const rot = await call(rotateRoute, { key: n.key });
    expect(rot.status, JSON.stringify(rot.body)).toBe(200);
    const fresh = { handle: n.handle, key: rot.body.api_key as string };
    expect((await read(fresh, g)).you).toBe("cant_read");
    expect((await read(l, g)).inputs_unreadable).toBe(true);
    await window();
    await offerJobs();
    // Nobody is asked again.
    expect(await offers()).toEqual(["moe", "nia"]);
    const c = await move(fresh, g, 1, { move: "claim", if_seq: 0 });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  });

  // Fable's review of 095: taking out a holder already frozen takes no one
  // away, so the claim's end is nobody's write and the leader is woken.
  it("wakes a leader that takes out a frozen holder before its lease ends", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [m, n] = members as [Bot, Bot];
    await post(l, g);
    expect((await cantRead(m, g)).status).toBe(200);
    const c = await move(n, g, 1, { move: "claim", if_seq: 0 });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    // A lever pulled from the command line: no pass runs.
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'nia'`;
    const before = await wake(l);
    const r = await call(removeRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "nia" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await offerJobs();
    expect((await read(l, g)).inputs_unreadable).toBe(true);
    expect(await marks()).toEqual([
      { episode: 1, woken: true, reason: "inputs_unreadable" },
    ]);
    expect(await wake(l)).toBe(before + 1);
  });

  // The same review: a lease that ran out before the leader took its holder
  // out ended by itself, so the take-out isn't the claim's end.
  it("wakes a leader that takes out a holder after its lease ran out", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [m, n] = members as [Bot, Bot];
    await post(l, g);
    expect((await cantRead(m, g)).status).toBe(200);
    const c = await move(n, g, 1, { move: "claim", if_seq: 0 });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'nia'`;
    await age(241);
    const before = await wake(l);
    const r = await call(removeRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "nia" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await offerJobs();
    expect(await marks()).toEqual([
      { episode: 1, woken: true, reason: "inputs_unreadable" },
    ]);
    expect(await wake(l)).toBe(before + 1);
  });

  it("lets a member that came back say so again", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [, n] = members as [Bot, Bot];
    await post(l, g);
    expect((await cantRead(n, g)).status).toBe(200);
    await call(leaveRoute, { key: n.key, params: { id: num(g) } });
    await join(n, l, g);
    const again = await cantRead(n, g);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.already).toBeFalsy();
    expect((await read(n, g)).you).toBe("cant_read");
  });

  it("counts no take-out of a member that had already said so", async () => {
    const { l, members, g } = await group();
    const [m, n] = members as [Bot, Bot, Bot];
    await post(l, g);
    await cantRead(m, g);
    await cantRead(n, g);
    await age(60);
    // A freeze from the command line leaves only blocked members; lea then
    // takes out nia, which had said so: that changes nobody who could take
    // it, so the freeze is still what left nobody.
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'oto'`;
    const before = await wake(l);
    const r = await call(removeRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "nia" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await offerJobs();
    expect(await marks()).toEqual([
      { episode: 0, woken: true, reason: "inputs_unreadable" },
    ]);
    expect(await wake(l)).toBe(before + 1);
  });

  it("keeps a member's word through a freeze and an unfreeze", async () => {
    const { l, members, g } = await group(["moe", "nia"]);
    const [m, n] = members as [Bot, Bot];
    await post(l, g);
    expect((await cantRead(m, g)).status).toBe(200);
    await setFrozen(db(), "moe", true, "test");
    await setFrozen(db(), "moe", false, "test");
    expect((await read(m, g)).you).toBe("cant_read");
    const before = await wake(l);
    expect((await cantRead(n, g)).status).toBe(200);
    await offerJobs();
    expect(await marks()).toEqual([
      { episode: 0, woken: true, reason: "inputs_unreadable" },
    ]);
    expect(await wake(l)).toBe(before + 1);
  });
});
