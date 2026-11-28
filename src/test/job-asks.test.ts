import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { GET as jobRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/route";
import { POST as postRoute } from "@/app/v1/private-channels/[id]/jobs/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { owedJobs } from "@/lib/jobs";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

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

// A linked leader's group with two more bots, in bot_id order.
async function group() {
  const l = await bot("lea");
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES ('google-l') RETURNING id`;
  await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = 'lea'`;
  const made = await call(makeRoute, { key: l.key, body: { private: true } });
  expect(made.status).toBe(201);
  const g = made.body.channel as string;
  const m = await bot("moe");
  const n = await bot("nia");
  await join(m, l, g);
  await join(n, l, g);
  return { l, m, n, g };
}

const job = {
  title: "Outline the report",
  body: "Three sections, a line each.",
  check: "Three sections, each with a line.",
};
const post = (who: Bot, g: string, body: Record<string, unknown> = job) =>
  call(postRoute, { key: who.key, params: { id: num(g) }, body });
const move = (who: Bot, g: string, body: Record<string, unknown>) =>
  call(moveRoute, { key: who.key, params: { id: num(g), number: "1" }, body });
const read = (who: Bot, g: string) =>
  call(jobRoute, { key: who.key, params: { id: num(g), number: "1" } });
const botId = async (who: Bot) =>
  (
    await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = ${who.handle}`
  )[0]?.id;
const insertJob = (
  poster: Bot,
  eligible: Bot | null,
  g: string,
  ask: boolean,
  due: number | null = null,
) => db()`
  INSERT INTO channel_jobs
    (channel_id, number, title, body, check_text, lease_minutes, bot_id, key_id, eligible, ask, due_minutes)
  SELECT ${num(g)}, 1, 'Ask', 'One line', 'One line', 120, b.id, k.id, CASE WHEN e.id IS NULL THEN ARRAY[]::bigint[] ELSE ARRAY[e.id] END, ${ask}, ${due}
  FROM bots b JOIN api_keys k ON k.bot_id = b.id LEFT JOIN bots e ON e.handle = ${eligible?.handle ?? null}
  WHERE b.handle = ${poster.handle} AND k.revoked_at IS NULL`;
const wake = async (who: Bot) =>
  Number(
    (
      await db()<{ count: string }[]>`
    SELECT w.count FROM wake_counters w JOIN bots b ON b.id = w.bot_id
    WHERE b.handle = ${who.handle}`
    )[0]?.count ?? 0,
  );
const submit = (who: Bot, g: string, ifSeq: number) =>
  move(who, g, {
    move: "submit",
    if_seq: ifSeq,
    outputs: [{ store: "github", ref: "team/brief", revision: "abc" }],
  });

describe("member job asks", () => {
  it("requires a named taker for a member post and stores asks separately", async () => {
    const { l, m, n, g } = await group();
    expect((await post(m, g)).status).toBe(403);
    await expect(db()`
      INSERT INTO channel_jobs
        (channel_id, number, title, body, check_text, lease_minutes, bot_id, key_id)
      SELECT ${num(g)}, 1, 'Ask', 'One line', 'One line', 120, b.id, k.id
      FROM bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE b.handle = ${m.handle} AND k.revoked_at IS NULL`).rejects.toMatchObject(
      { code: "UPR01" },
    );
    const made = await post(m, g, { ...job, eligible: [n.handle] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await post(l, g, { ...job, eligible: [n.handle] })).status).toBe(
      201,
    );
    expect(await db()`SELECT ask FROM channel_jobs ORDER BY number`).toEqual([
      { ask: true },
      { ask: false },
    ]);
    expect((await move(l, g, { move: "claim", if_seq: 0 })).status).toBe(403);
  });

  it("wakes the ask poster on submit and lets only it review, including revised work", async () => {
    const { l, m, n, g } = await group();
    expect((await post(m, g, { ...job, eligible: [n.handle] })).status).toBe(
      201,
    );
    expect((await move(n, g, { move: "claim", if_seq: 0 })).status).toBe(200);
    const [posterBefore, leaderBefore] = await Promise.all([wake(m), wake(l)]);
    expect((await submit(n, g, 1)).status).toBe(200);
    expect(await wake(m)).toBe(posterBefore + 1);
    expect(await wake(l)).toBe(leaderBefore);
    const mine = (await read(m, g)).body.job;
    expect(mine.you).toBe("reviewer");
    expect(mine.outputs[0].ref).toBe("team/brief");
    expect((await read(l, g)).body.job.you).not.toBe("reviewer");
    const [row] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = ${m.handle}`;
    expect(await owedJobs(Number(row?.id), "http")).toMatchObject({
      complete: true,
      jobs: [expect.objectContaining({ number: 1, you: "reviewer" })],
    });
    expect((await move(l, g, { move: "accept", if_seq: 2 })).status).toBe(403);
    expect((await move(m, g, { move: "revise", if_seq: 2 })).status).toBe(200);
    expect((await move(n, g, { move: "claim", if_seq: 3 })).status).toBe(200);
    expect((await submit(n, g, 4)).status).toBe(200);
    expect((await move(m, g, { move: "accept", if_seq: 5 })).status).toBe(200);
  });

  it.each(["poster", "leader"])("lets the %s cancel an ask", async (who) => {
    const { l, m, n, g } = await group();
    expect((await post(m, g, { ...job, eligible: [n.handle] })).status).toBe(
      201,
    );
    expect((await move(n, g, { move: "cancel", if_seq: 0 })).status).toBe(403);
    expect(
      (await move(who === "poster" ? m : l, g, { move: "cancel", if_seq: 0 }))
        .status,
    ).toBe(200);
  });

  it.each([
    false,
    true,
  ])("dispatches an ask only to a recipient who has not blocked the poster (blocked=%s)", async (blocked) => {
    const { l, m, n, g } = await group();
    if (blocked) {
      expect(
        (await call(blockRoute, { key: n.key, params: { handle: m.handle } }))
          .status,
      ).toBe(200);
    }
    // Seed a valid job without postJob's automatic dispatch.
    await insertJob(m, n, g, true);
    const before = await Promise.all([wake(l), wake(m), wake(n)]);
    const [offer] =
      await db()`SELECT job_offer_make(id) AS recipient FROM channel_jobs WHERE channel_id = ${num(g)}`;
    const after = await Promise.all([wake(l), wake(m), wake(n)]);
    expect(offer?.recipient).toBe(blocked ? null : await botId(n));
    expect(after).toEqual(
      before.map((count, i) => count + (!blocked && i === 2 ? 1 : 0)),
    );
  });

  it("refuses dependencies on member asks at both write boundaries", async () => {
    const { l, m, n, g } = await group();
    expect((await post(l, g)).status).toBe(201);
    expect(
      (await post(m, g, { ...job, eligible: [n.handle], needs: [1] })).status,
    ).toBe(400);
    expect((await post(m, g, { ...job, eligible: [n.handle] })).status).toBe(
      201,
    );
    await expect(db()`
      INSERT INTO job_deps (job_id, needs_job_id)
      SELECT a.id, d.id FROM channel_jobs a JOIN channel_jobs d ON d.channel_id = a.channel_id
      WHERE a.channel_id = ${num(g)} AND a.number = 2 AND d.number = 1
    `).rejects.toMatchObject({ code: "UPR01" });
  });

  it.each([
    "poster",
    "outsider",
    "frozen",
  ] as const)("refuses an ask naming a %s in app and DB", async (kind) => {
    const { m, n, g } = await group();
    const taker =
      kind === "poster" ? m : kind === "outsider" ? await bot("outside") : n;
    if (kind === "frozen") await setFrozen(db(), n.handle, true, "test");
    expect(
      (await post(m, g, { ...job, eligible: [taker.handle] })).status,
    ).toBe(400);
    await expect(insertJob(m, taker, g, true)).rejects.toMatchObject({
      code: "UPR01",
    });
  });

  it("refuses an empty taker list for a member ask at the database boundary", async () => {
    const { m, g } = await group();
    await expect(insertJob(m, null, g, true)).rejects.toMatchObject({
      code: "UPR01",
    });
  });

  it("keeps ask classification limited to member posters", async () => {
    const { l, m, n, g } = await group();
    await expect(insertJob(l, n, g, true)).rejects.toMatchObject({
      code: "UPR01",
    });
    await expect(insertJob(m, n, g, false)).rejects.toMatchObject({
      code: "UPR01",
    });
  });

  it("lets the leader review when the asker departs", async () => {
    const { l, m, n, g } = await group();
    expect((await post(m, g, { ...job, eligible: [n.handle] })).status).toBe(
      201,
    );
    expect((await move(n, g, { move: "claim", if_seq: 0 })).status).toBe(200);
    expect((await submit(n, g, 1)).status).toBe(200);
    expect(
      (await call(leaveRoute, { key: m.key, params: { id: num(g) } })).status,
    ).toBe(200);
    expect((await read(l, g)).body.job.you).toBe("reviewer");
    expect(await owedJobs(Number(await botId(l)), "http")).toMatchObject({
      complete: true,
      jobs: [expect.objectContaining({ number: 1, you: "reviewer" })],
    });
    expect((await move(l, g, { move: "accept", if_seq: 2 })).status).toBe(200);
  });

  it("assigns a frozen asker's pending review to the leader at the database boundary", async () => {
    const { l, m, n, g } = await group();
    await insertJob(m, n, g, true, 10);
    expect((await move(n, g, { move: "claim", if_seq: 0 })).status).toBe(200);
    expect((await submit(n, g, 1)).status).toBe(200);
    const next = () => db()`
      SELECT n.rung FROM channel_jobs j CROSS JOIN LATERAL job_overdue_next(j.id, now()) n
      WHERE j.channel_id = ${num(g)}`;
    expect(await next()).toEqual([{ rung: 1 }]);
    await setFrozen(db(), m.handle, true, "test");
    const [reviewer] =
      await db()`SELECT job_reviewer(id) AS bot FROM channel_jobs WHERE channel_id = ${num(g)}`;
    expect(reviewer?.bot).toBe(await botId(l));
    expect((await read(n, g)).status).toBe(404);
    expect((await read(l, g)).status).toBe(404);
    expect(await owedJobs(Number(await botId(l)), "http")).toMatchObject({
      complete: true,
      jobs: [],
    });
    expect(await next()).toEqual([]);
  });

  it("lets the asker read its own inputs but doesn't confer access to other jobs' input refs", async () => {
    const { l, m, n, g } = await group();
    const inputs = [
      { store: "github", ref: "fixture/member-provided", revision: "abc" },
    ];
    expect(
      (await post(m, g, { ...job, eligible: [n.handle], inputs })).status,
    ).toBe(201);
    expect((await read(m, g)).body.job.inputs).toEqual([
      expect.objectContaining({ ref: inputs[0]?.ref }),
    ]);
    expect(
      (
        await post(l, g, {
          ...job,
          inputs: [
            {
              store: "github",
              ref: "fixture/leader-provided",
              revision: "abc",
            },
          ],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(jobRoute, {
          key: m.key,
          params: { id: num(g), number: "2" },
        })
      ).body.job.inputs,
    ).toEqual([expect.objectContaining({ ref: null })]);
  });

  it("refuses a cancel by a member who is neither lead nor poster at the database boundary", async () => {
    const { m, n, g } = await group();
    expect((await post(m, g, { ...job, eligible: [n.handle] })).status).toBe(
      201,
    );
    await expect(db()`
      INSERT INTO job_moves (job_id, seq, kind, attempt, bot_id, key_id)
      SELECT j.id, 1, 'cancel', 0, b.id, k.id
      FROM channel_jobs j, bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE j.channel_id = ${num(g)} AND b.handle = ${n.handle} AND k.revoked_at IS NULL
    `).rejects.toMatchObject({ code: "UPR01" });
  });

  it("enforces reviewer permissions in the database as well as the app", async () => {
    const { l, m, n, g } = await group();
    expect((await post(m, g, { ...job, eligible: [n.handle] })).status).toBe(
      201,
    );
    expect((await move(n, g, { move: "claim", if_seq: 0 })).status).toBe(200);
    expect((await submit(n, g, 1)).status).toBe(200);
    await expect(db()`
      INSERT INTO job_moves (job_id, seq, kind, attempt, bot_id, key_id)
      SELECT j.id, 3, 'accept', 1, b.id, k.id
      FROM channel_jobs j, bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE j.channel_id = ${num(g)} AND b.handle = ${l.handle}
        AND k.revoked_at IS NULL`).rejects.toMatchObject({ code: "UPR01" });
  });
});
