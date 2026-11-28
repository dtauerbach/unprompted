import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { POST as inviteRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { setFrozen, setPrivateChannelHidden, setSilenced } from "@/lib/admin";
import { db } from "@/lib/db";
import { checkDue, forgetDueMinute } from "@/lib/due-check";
import { offerJobs, sweepJobOverdue } from "@/lib/job-offers";
import { ANTI_ABUSE_DEFAULTS } from "@/lib/settings";
import { call, register, resetDb } from "./helpers";
import { resetNextCache } from "./next-cache";

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
  const insertJob = async (
    minutes: number | null,
    number = 1,
    eligible?: Bot[],
  ) => {
    const list = eligible
      ? await Promise.all(
          eligible.map(async (who) => {
            const member = await botId(who);
            if (!member) throw new Error("missing eligible member");
            return member;
          }),
        )
      : null;
    const [job] = await db()<{ id: string }[]>`
    INSERT INTO channel_jobs
      (channel_id, number, title, body, check_text, lease_minutes, bot_id, key_id, due_minutes, eligible)
    SELECT ${id}, ${number}, 'Write a brief', 'One page', 'One page', 120, b.id, k.id, ${minutes}, ${list}::bigint[]
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

async function timedAsk(f: Awaited<ReturnType<typeof fixture>>) {
  const [ask] = await db()<{ id: string }[]>`
    INSERT INTO channel_jobs
      (channel_id, number, title, body, check_text, lease_minutes, bot_id, key_id, eligible, ask, due_minutes)
    SELECT ${f.id}, 2, 'Review fixture', 'One line', 'One line', 120, b.id, k.id, ARRAY[e.id], true, 10
    FROM bots b JOIN api_keys k ON k.bot_id = b.id CROSS JOIN bots e
    WHERE b.handle = ${f.other.handle} AND e.handle = ${f.holder.handle} AND k.revoked_at IS NULL
    RETURNING id`;
  if (!ask) throw new Error("missing ask");
  return ask.id;
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

// Test-only clock fixture: migration 105 spaces rungs by elapsed time.
async function ageRung(job: string, rung: number) {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE job_overdue DISABLE TRIGGER job_overdue_append_only`;
    await tx`UPDATE job_overdue SET at = clock_timestamp() - interval '15 minutes'
             WHERE job_id = ${job} AND rung = ${rung}`;
    await tx`ALTER TABLE job_overdue ENABLE TRIGGER job_overdue_append_only`;
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
    const otherWake = await wake(f.other);
    await age(f.job, 26);
    await make(f.job, 1);
    await ageRung(f.job, 1);
    await make(f.job, 2);
    expect(await rows(f.job)).toEqual([
      { rung: 1, bot_id: await botId(f.leader), woken: true },
      { rung: 2, bot_id: await botId(f.other), woken: true },
    ]);
    expect(await wake(f.leader)).toBe(leadWake + 1);
    expect(await wake(f.other)).toBe(otherWake + 1);
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
    await ageRung(f.job, 1);
    await make(f.job, 2);
    await ageRung(f.job, 2);
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

  it("notifies the leader when a claimed holder freezes, without waking the former holder", async () => {
    const f = await fixture();
    await f.claim();
    expect(
      (await db()`SELECT state FROM job_state(${f.job}, clock_timestamp())`)[0]
        ?.state,
    ).toBe("claimed");
    await setFrozen(db(), f.holder.handle, true, "test");
    await age(f.job, 11);
    const before = await wake(f.holder);
    expect(await make(f.job, 1)).toEqual([
      { rung: 1, bot_id: await botId(f.leader), woken: true },
    ]);
    expect(await wake(f.holder)).toBe(before);
  });

  it("wakes the leader when the leader's own claim is overdue", async () => {
    const f = await fixture();
    await f.claim(f.leader);
    await age(f.job, 11);
    const before = await wake(f.leader);
    expect(await make(f.job, 1)).toEqual([
      { rung: 1, bot_id: await botId(f.leader), woken: true },
    ]);
    expect(await wake(f.leader)).toBe(before + 1);
  });

  it.each([
    "ready",
    "lapsed",
  ] as const)("wakes the leader for %s work", async (state) => {
    const f = await fixture();
    if (state === "lapsed") {
      await f.claim();
      await db().begin(async (tx) => {
        await tx`ALTER TABLE job_moves DISABLE TRIGGER job_moves_append_only`;
        await tx`UPDATE job_moves SET lease_until = now() - interval '1 second' WHERE job_id = ${f.job}`;
        await tx`ALTER TABLE job_moves ENABLE TRIGGER job_moves_append_only`;
      });
    }
    await age(f.job, 26);
    expect(await make(f.job, 1)).toEqual([
      { rung: 1, bot_id: await botId(f.leader), woken: true },
    ]);
    await ageRung(f.job, 1);
    expect(await make(f.job, 2)).toEqual([
      {
        rung: 2,
        bot_id: await botId(state === "lapsed" ? f.other : f.holder),
        woken: true,
      },
    ]);
  });

  it("doesn't consume a rung for a job waiting on a dependency", async () => {
    const f = await fixture();
    const waiting = await f.insertJob(10, 2);
    await db()`INSERT INTO job_deps (job_id, needs_job_id) VALUES (${waiting}, ${f.job})`;
    await age(waiting, 41);
    expect(await make(waiting, 1)).toEqual([]);
    expect(await rows(waiting)).toEqual([]);
  });

  it("enforces both bounds of the optional deadline", async () => {
    const f = await fixture();
    await expect(f.insertJob(9, 2)).rejects.toMatchObject({ code: "23514" });
    await expect(f.insertJob(1441, 2)).rejects.toMatchObject({ code: "23514" });
    await expect(f.insertJob(1440, 2)).resolves.toBeTruthy();
  });

  it("checks the bot at due time and keeps the durable record append-only", async () => {
    const f = await fixture();
    await f.claim();
    await age(f.job, 11);
    const other = await botId(f.other);
    if (!other) throw new Error("missing other member");
    await expect(db()`
      INSERT INTO job_overdue (job_id, rung, bot_id, woken)
      VALUES (${f.job}, 1, ${other}, true)`).rejects.toMatchObject({
      code: "UPR01",
    });
    await make(f.job, 1);
    await expect(
      db()`DELETE FROM job_overdue WHERE job_id = ${f.job}`,
    ).rejects.toThrow();
    await expect(
      db()`UPDATE job_overdue SET at = at - interval '1 minute' WHERE job_id = ${f.job}`,
    ).rejects.toThrow();
    expect(await rows(f.job)).toHaveLength(1);
  });

  it("skips a live claimed holder who blocked the poster", async () => {
    const f = await fixture();
    await f.claim();
    const b = await call(blockRoute, {
      key: f.holder.key,
      params: { handle: f.leader.handle },
    });
    expect(b.status).toBe(200);
    await age(f.job, 11);
    expect(
      (await db()`SELECT state FROM job_state(${f.job}, clock_timestamp())`)[0]
        ?.state,
    ).toBe("claimed");
    const before = await wake(f.holder);
    expect(await make(f.job, 1)).toEqual([
      { rung: 1, bot_id: null, woken: false },
    ]);
    expect(await wake(f.holder)).toBe(before);
  });

  it("never starts a ladder for a frozen poster", async () => {
    const f = await fixture();
    await f.claim();
    await setFrozen(db(), f.leader.handle, true, "test");
    await age(f.job, 41);
    expect(await make(f.job, 1)).toEqual([]);
    expect(await rows(f.job)).toEqual([]);
  });

  it("skips a fallback member who blocked the poster", async () => {
    const f = await fixture();
    await f.claim();
    await f.submit();
    const b = await call(blockRoute, {
      key: f.other.key,
      params: { handle: f.leader.handle },
    });
    expect(b.status).toBe(200);
    await age(f.job, 26);
    await make(f.job, 1);
    await ageRung(f.job, 1);
    await make(f.job, 2);
    expect((await rows(f.job)).at(-1)).toEqual({
      rung: 2,
      bot_id: null,
      woken: false,
    });
  });

  it.each([
    "closed",
    "hidden",
  ] as const)("does not dispatch for a %s group", async (state) => {
    const f = await fixture();
    await f.claim();
    await age(f.job, 41);
    if (state === "closed") {
      expect(
        (await call(closeRoute, { key: f.leader.key, params: { id: f.id } }))
          .status,
      ).toBe(200);
    } else {
      await setPrivateChannelHidden(db(), Number(f.id), true, "test");
    }
    expect(await make(f.job, 1)).toEqual([]);
    expect(await rows(f.job)).toEqual([]);
  });

  it("records a skipped rung for a silenced holder without waking it", async () => {
    const f = await fixture();
    await f.claim();
    await setSilenced(db(), f.holder.handle, 2, "test");
    await age(f.job, 26);
    const before = await wake(f.holder);
    expect(await make(f.job, 1)).toEqual([
      { rung: 1, bot_id: null, woken: false },
    ]);
    expect(await wake(f.holder)).toBe(before);
    await ageRung(f.job, 1);
    expect(await make(f.job, 2)).toEqual([
      { rung: 2, bot_id: await botId(f.leader), woken: true },
    ]);
  });

  it("includes the next overdue rung in the dispatch clock", async () => {
    const f = await fixture();
    await f.claim();
    await age(f.job, 11);
    const [clock] = await db()`
      SELECT job_dispatch_soonest() = d.due_at AS matches
      FROM job_overdue_due(now(), ${f.id}) d WHERE d.job_id = ${f.job}`;
    expect(clock?.matches).toBe(true);
  });

  it("rejects a deadline on a member ask at the database boundary", async () => {
    const f = await fixture(null);
    await expect(timedAsk(f)).rejects.toMatchObject({
      code: "23514",
      constraint_name: "channel_jobs_ask_without_due",
    });
  });

  it("escalates a leader job to the lead even when only its holder may take it", async () => {
    const f = await fixture(null);
    const named = await f.insertJob(10, 2, [f.holder]);
    expect(
      (
        await call(moveRoute, {
          key: f.holder.key,
          params: { id: f.id, number: "2" },
          body: { move: "claim", if_seq: 0 },
        })
      ).status,
    ).toBe(200);
    await age(named, 26);
    expect(await make(named, 1)).toHaveLength(1);
    await ageRung(named, 1);
    expect(await make(named, 2)).toEqual([
      { rung: 2, bot_id: await botId(f.leader), woken: true },
    ]);
  });

  it("excludes the newest offer but not an earlier offer in the episode", async () => {
    const f = await fixture(null);
    const named = await f.insertJob(10, 2, [f.holder, f.other]);
    await age(named, 26);
    await offerJobs({ channel: Number(f.id) });
    await db().begin(async (tx) => {
      await tx`ALTER TABLE job_offers DISABLE TRIGGER job_offers_append_only`;
      await tx`UPDATE job_offers SET created_at = created_at - interval '16 minutes'
               WHERE job_id = ${named}`;
      await tx`ALTER TABLE job_offers ENABLE TRIGGER job_offers_append_only`;
    });
    await offerJobs({ channel: Number(f.id) });
    const offered = await db()`
      SELECT bot_id FROM job_offers WHERE job_id = ${named} ORDER BY id`;
    expect(offered).toEqual([
      { bot_id: await botId(f.holder) },
      { bot_id: await botId(f.other) },
    ]);
    expect(await make(named, 1)).toHaveLength(1);
    await ageRung(named, 1);
    expect(await make(named, 2)).toEqual([
      { rung: 2, bot_id: await botId(f.holder), woken: true },
    ]);
  });

  it.each([
    false,
    true,
  ])("uses the named fallback only without a standing offer (%s)", async (offered) => {
    const f = await fixture(null);
    const named = await f.insertJob(10, 2, [f.other]);
    if (offered) await offerJobs({ channel: Number(f.id) });
    await age(named, 26);
    expect(await make(named, 1)).toHaveLength(1);
    await ageRung(named, 1);
    expect(await make(named, 2)).toEqual([
      {
        rung: 2,
        bot_id: offered ? null : await botId(f.other),
        woken: !offered,
      },
    ]);
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

// Keep the real clock path under test while simulating a new minute/cache
// boundary between checks, without sleeping or invoking a real push.
async function clockRound() {
  resetNextCache();
  forgetDueMinute();
  return checkDue();
}

describe("the clock dispatches bot-only overdue rungs", () => {
  it("alerts once when every due rung fails, without writing a rung", async () => {
    const f = await fixture();
    await f.claim();
    await age(f.job, 11);
    await db().begin(async (tx) => {
      await tx`CREATE FUNCTION fail_overdue_fixture() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture write failed'; END; $$`;
      await tx`CREATE TRIGGER fail_overdue_fixture BEFORE INSERT ON job_overdue
        FOR EACH ROW EXECUTE FUNCTION fail_overdue_fixture()`;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let n = 0; n < 2; n += 1)
        expect(await sweepJobOverdue(Date.now() + 10_000)).toBe(0);
      expect(await rows(f.job)).toEqual([]);
      const alerts = await db()`
        SELECT detail FROM action_log WHERE action = 'alert.job_offers_failed'`;
      expect(alerts).toEqual([{ detail: { jobs: 1 } }]);
    } finally {
      errors.mockRestore();
      await db().begin(async (tx) => {
        await tx`DROP TRIGGER fail_overdue_fixture ON job_overdue`;
        await tx`DROP FUNCTION fail_overdue_fixture()`;
      });
    }
  });

  it("leaves a future deadline alone, then wakes the holder and fallback once", async () => {
    const f = await fixture();
    await f.claim();
    const holderBefore = await wake(f.holder);
    const leadBefore = await wake(f.leader);
    await clockRound();
    expect(await rows(f.job)).toEqual([]);

    await age(f.job, 26);
    await clockRound();
    await clockRound();
    expect(await rows(f.job)).toEqual([
      { rung: 1, bot_id: await botId(f.holder), woken: true },
    ]);
    expect(await wake(f.holder)).toBe(holderBefore + 1);
    expect(await wake(f.leader)).toBe(leadBefore);

    await ageRung(f.job, 1);
    await clockRound();
    await clockRound();
    expect(await rows(f.job)).toEqual([
      { rung: 1, bot_id: await botId(f.holder), woken: true },
      { rung: 2, bot_id: await botId(f.leader), woken: true },
    ]);
    expect(await wake(f.holder)).toBe(holderBefore + 1);
    expect(await wake(f.leader)).toBe(leadBefore + 1);
  });

  it("does not keep the clock due or consume a matured third rung", async () => {
    const f = await fixture();
    await f.claim();
    await age(f.job, 41);
    expect(await make(f.job, 1)).toHaveLength(1);
    await ageRung(f.job, 1);
    expect(await make(f.job, 2)).toHaveLength(1);
    await ageRung(f.job, 2);
    expect(await clockRound()).toBe("not_due");
    expect((await rows(f.job)).map((x) => x.rung)).toEqual([1, 2]);
  });
  it("leaves a capped wake pending and charges exactly one use on retry", async () => {
    const f = await fixture();
    await f.claim();
    await age(f.job, 11);
    const before = await wake(f.holder);
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES ('channel-wake:all', date_trunc('hour', now()),
              ${ANTI_ABUSE_DEFAULTS.channel_wake_global})
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = EXCLUDED.count`;
    await clockRound();
    expect(await rows(f.job)).toEqual([]);
    expect(await wake(f.holder)).toBe(before);

    await db()`DELETE FROM rate_limits WHERE bucket = 'channel-wake:all'`;
    await clockRound();
    await clockRound();
    expect(await rows(f.job)).toHaveLength(1);
    expect(await wake(f.holder)).toBe(before + 1);
    const [used] = await db()<{ count: number }[]>`
      SELECT count FROM rate_limits WHERE bucket = 'channel-wake:all'`;
    expect(used?.count).toBe(1);
    const [logged] = await db()`
      SELECT bot_id, detail FROM action_log WHERE action = 'channel.job.overdue'`;
    expect(logged).toMatchObject({
      bot_id: await botId(f.holder),
      detail: { number: 1, rung: 1, woken: true },
    });
  });
  it("records a no-wake rung at cap without charging or waking a silenced holder", async () => {
    const f = await fixture();
    await f.claim();
    await setSilenced(db(), f.holder.handle, 2, "test");
    await age(f.job, 11);
    const before = await wake(f.holder);
    const cap = ANTI_ABUSE_DEFAULTS.channel_wake_global;
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES ('channel-wake:all', date_trunc('hour', now()), ${cap})
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = EXCLUDED.count`;
    await clockRound();
    expect(await rows(f.job)).toEqual([
      { rung: 1, bot_id: null, woken: false },
    ]);
    expect(await wake(f.holder)).toBe(before);
    const [used] = await db()<{ count: number }[]>`
      SELECT count FROM rate_limits WHERE bucket = 'channel-wake:all'
        AND window_start = date_trunc('hour', now())`;
    expect(used?.count).toBe(cap);
    const [logged] = await db()`
      SELECT bot_id, detail FROM action_log WHERE action = 'channel.job.overdue'`;
    expect(logged).toMatchObject({
      bot_id: null,
      detail: { number: 1, rung: 1, woken: false },
    });
  });
});
