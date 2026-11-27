import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as inviteRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

type Bot = { handle: string; key: string };
type Row = { rung: number; bot_id: string | null; woken: boolean };

async function fixture(due: number | null = 10) {
  const leader = await register("lea");
  const holder = await register("moe");
  const other = await register("nia");
  await db()`UPDATE bots SET created_at = now() - interval '3 days'`;
  const [person] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES ('google-lea') RETURNING id`;
  await db()`UPDATE bots SET owner_id = ${person?.id ?? null} WHERE handle = 'lea'`;
  const group = await call(makeRoute, {
    key: leader.key,
    body: { private: true },
  });
  expect(group.status).toBe(201);
  const id = (group.body.channel as string).replace("private:", "");
  for (const member of [holder, other]) {
    const invite = await call(inviteRoute, {
      key: leader.key,
      params: { id },
      body: { for: member.handle },
    });
    expect(invite.status).toBe(201);
    expect(
      (
        await call(redeemRoute, {
          key: member.key,
          body: { code: invite.body.invite.code },
        })
      ).status,
    ).toBe(200);
  }
  // D1 adds the SQL field only. The posting interface is a separate job.
  const [job] = await db()<{ id: string }[]>`
    INSERT INTO channel_jobs
      (channel_id, number, title, body, check_text, lease_minutes, bot_id, key_id, due_minutes)
    SELECT ${id}, 1, 'Write a brief', 'One page', 'One page', 120, b.id, k.id, ${due}
    FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
    WHERE b.handle = 'lea' RETURNING id`;
  if (!job) throw new Error("job not inserted");
  const move = async (who: Bot, body: Record<string, unknown>) => {
    const response = await call(moveRoute, {
      key: who.key,
      params: { id, number: "1" },
      body,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  };
  const claim = (who = holder) => move(who, { move: "claim", if_seq: 0 });
  const submit = (who = holder) =>
    move(who, {
      move: "submit",
      if_seq: 1,
      outputs: [{ store: "github", ref: "brief.md", revision: "abc" }],
    });
  return { id, job: job.id, leader, holder, other, move, claim, submit };
}

const botId = async (who: Bot) =>
  (
    await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = ${who.handle}`
  )[0]?.id;
const wake = async (who: Bot) =>
  Number(
    (
      await db()<{ count: string }[]>`
    SELECT w.count FROM wake_counters w JOIN bots b ON b.id = w.bot_id
    WHERE b.handle = ${who.handle}`
    )[0]?.count ?? 0,
  );
const rows = (job: string) => db()<Row[]>`
  SELECT rung, bot_id, woken FROM job_overdue WHERE job_id = ${job} ORDER BY rung`;
const make = (job: string, rung: number) => db()<Row[]>`
  SELECT rung, bot_id, woken FROM job_overdue_make(${job}, ${rung})`;

async function age(job: string, minutes: number) {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE channel_jobs DISABLE TRIGGER channel_jobs_append_only`;
    await tx`UPDATE channel_jobs SET created_at = clock_timestamp() - make_interval(mins => ${minutes})
             WHERE id = ${job}`;
    await tx`ALTER TABLE channel_jobs ENABLE TRIGGER channel_jobs_append_only`;
  });
}

describe("job overdue ladder", () => {
  it("wakes the live holder exactly once when the first rung is due", async () => {
    const f = await fixture();
    await f.claim();
    expect(await make(f.job, 1)).toEqual([]);
    await age(f.job, 11);
    const before = await wake(f.holder);
    expect(await make(f.job, 1)).toEqual([
      { rung: 1, bot_id: await botId(f.holder), woken: true },
    ]);
    expect(await make(f.job, 1)).toEqual([]);
    expect(await wake(f.holder)).toBe(before + 1);
  });

  it("holds a waking rung if the dispatcher has no wake budget", async () => {
    const f = await fixture();
    await f.claim();
    await age(f.job, 11);
    const before = await wake(f.holder);
    expect(
      await db()`
      SELECT * FROM job_overdue_make(${f.job}, 1, false)`,
    ).toEqual([]);
    expect(await rows(f.job)).toEqual([]);
    expect(await wake(f.holder)).toBe(before);
    expect(await make(f.job, 1)).toHaveLength(1);
    expect(await wake(f.holder)).toBe(before + 1);
  });

  it("asks the lead to review, then wakes the longest-standing other member", async () => {
    const f = await fixture();
    await f.claim();
    await f.submit();
    const leadWake = await wake(f.leader);
    const otherWake = await wake(f.holder);
    await age(f.job, 26);
    await make(f.job, 1);
    await make(f.job, 2);
    expect(await rows(f.job)).toEqual([
      { rung: 1, bot_id: await botId(f.leader), woken: true },
      { rung: 2, bot_id: await botId(f.holder), woken: true },
    ]);
    expect(await wake(f.leader)).toBe(leadWake + 1);
    expect(await wake(f.holder)).toBe(otherWake + 1);
  });

  it("marks the person's rung without a bot wake and refuses a premature or forged write", async () => {
    const f = await fixture();
    await f.claim();
    await expect(db()`
      INSERT INTO job_overdue (job_id, rung, bot_id, woken)
      VALUES (${f.job}, 3, NULL, false)`).rejects.toMatchObject({
      code: "UPR01",
    });
    await age(f.job, 41);
    const before = await wake(f.holder);
    await make(f.job, 1);
    await make(f.job, 2);
    await make(f.job, 3);
    await make(f.job, 3);
    expect((await rows(f.job)).at(-1)).toEqual({
      rung: 3,
      bot_id: null,
      woken: false,
    });
    expect(await wake(f.holder)).toBe(before + 1);
  });

  it.each(["accept", "cancel"])("does not dispatch after %s", async (kind) => {
    const f = await fixture();
    await f.claim();
    await f.submit();
    await f.move(f.leader, { move: kind, if_seq: 2 });
    await age(f.job, 45);
    expect(await make(f.job, 1)).toEqual([]);
    expect(await rows(f.job)).toEqual([]);
  });

  it("does not wake a frozen holder", async () => {
    const f = await fixture();
    await f.claim();
    await setFrozen(db(), f.holder.handle, true, "test");
    await age(f.job, 11);
    const before = await wake(f.holder);
    await make(f.job, 1);
    expect(await wake(f.holder)).toBe(before);
  });

  it("records the poster's own move without waking the poster", async () => {
    const f = await fixture();
    await f.claim(f.leader);
    await age(f.job, 11);
    const before = await wake(f.leader);
    expect(await make(f.job, 1)).toEqual([
      { rung: 1, bot_id: null, woken: false },
    ]);
    expect(await wake(f.leader)).toBe(before);
  });

  it("skips a fallback member who blocked the poster", async () => {
    const f = await fixture();
    await f.claim();
    await f.submit();
    const b = await call(blockRoute, {
      key: f.holder.key,
      params: { handle: f.leader.handle },
    });
    expect(b.status).toBe(200);
    await age(f.job, 26);
    await make(f.job, 1);
    await make(f.job, 2);
    expect((await rows(f.job)).at(-1)).toEqual({
      rung: 2,
      bot_id: await botId(f.other),
      woken: true,
    });
  });

  it("leaves an existing job with no due time out of the dispatch scan", async () => {
    const f = await fixture(null);
    await f.claim();
    await age(f.job, 45);
    expect(
      await db()`
      SELECT job_id FROM job_overdue_due(clock_timestamp(), ${f.id})`,
    ).toEqual([]);
  });
});
