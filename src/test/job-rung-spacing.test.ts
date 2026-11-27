import { beforeEach, describe, expect, it } from "vitest";
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
  const insertJob = async (minutes: number | null, number = 1) => {
    const [job] = await db()<{ id: string }[]>`
    INSERT INTO channel_jobs
      (channel_id, number, title, body, check_text, lease_minutes, bot_id, key_id, due_minutes)
    SELECT ${id}, ${number}, 'Write a brief', 'One page', 'One page', 120, b.id, k.id, ${minutes}
    FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
    WHERE b.handle = 'lea' RETURNING id`;
    if (!job) throw new Error("job not inserted");
    return job.id;
  };
  const job = await insertJob(due);
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
  return { id, job, leader, holder, other, move, claim, submit, insertJob };
}

const botId = async (who: Bot) =>
  (
    await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = ${who.handle}`
  )[0]?.id;
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

// Fixture-only elapsed time without sleeping; the production row stays append-only.
async function ageRung(job: string, rung: number, minutes: number) {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE job_overdue DISABLE TRIGGER job_overdue_append_only`;
    await tx`UPDATE job_overdue SET at = clock_timestamp() - make_interval(mins => ${minutes})
             WHERE job_id = ${job} AND rung = ${rung}`;
    await tx`ALTER TABLE job_overdue ENABLE TRIGGER job_overdue_append_only`;
  });
}

describe("spacing overdue rungs", () => {
  it("starts only the first rung when an old dependency clears", async () => {
    const f = await fixture(null);
    const waiting = await f.insertJob(10, 2);
    await db()`INSERT INTO job_deps (job_id, needs_job_id) VALUES (${waiting}, ${f.job})`;
    await age(waiting, 45);
    expect(await make(waiting, 1)).toEqual([]);
    await f.claim();
    await f.submit();
    await f.move(f.leader, { move: "accept", if_seq: 2 });

    const [clock] = await db()`
      SELECT n.due_at = m.created_at AS matches
      FROM job_overdue_next(${waiting}, now()) n
      JOIN job_moves m ON m.job_id = ${f.job} AND m.kind = 'accept'`;
    expect(clock?.matches).toBe(true);
    expect(await make(waiting, 1)).toHaveLength(1);
    expect(await make(waiting, 2)).toEqual([]);
    await ageRung(waiting, 1, 14);
    expect(await make(waiting, 2)).toEqual([]);
    await ageRung(waiting, 1, 15);
    expect(await make(waiting, 2)).toHaveLength(1);
    expect(await make(waiting, 3)).toEqual([]);
  });

  it("keeps the spacing floor across a poster freeze and unfreeze", async () => {
    const f = await fixture();
    await f.claim();
    await age(f.job, 45);
    expect(await make(f.job, 1)).toHaveLength(1);
    await setFrozen(db(), f.leader.handle, true, "test");
    expect(await make(f.job, 2)).toEqual([]);
    await setFrozen(db(), f.leader.handle, false, "test");
    expect(await make(f.job, 2)).toEqual([]);
    await ageRung(f.job, 1, 15);
    expect(await make(f.job, 2)).toHaveLength(1);
    expect(await rows(f.job)).toHaveLength(2);
  });

  it("rejects a direct insert before the previous rung has aged", async () => {
    const f = await fixture();
    await f.claim();
    await age(f.job, 45);
    expect(await make(f.job, 1)).toHaveLength(1);
    const lead = await botId(f.leader);
    if (!lead) throw new Error("missing leader");
    await expect(db()`
      INSERT INTO job_overdue (job_id, rung, bot_id, woken)
      VALUES (${f.job}, 2, ${lead}, true)`).rejects.toMatchObject({
      code: "UPR01",
    });
    expect(await rows(f.job)).toHaveLength(1);
  });

  it("does not date an overdue claim before the move that made it owed", async () => {
    const f = await fixture();
    await age(f.job, 45);
    await f.claim();
    const [clock] = await db()`
      SELECT n.due_at = m.created_at AS matches
      FROM job_overdue_next(${f.job}, now()) n
      JOIN job_moves m ON m.job_id = ${f.job} AND m.kind = 'claim'`;
    expect(clock?.matches).toBe(true);
  });
});
