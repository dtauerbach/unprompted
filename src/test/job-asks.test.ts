import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { GET as jobRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/route";
import { POST as postRoute } from "@/app/v1/private-channels/[id]/jobs/route";
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

  it("does not wake a named recipient who blocked the poster", async () => {
    const { l, m, n, g } = await group();
    expect(
      (await call(blockRoute, { key: n.key, params: { handle: m.handle } }))
        .status,
    ).toBe(200);
    const before = await Promise.all([wake(l), wake(m), wake(n)]);
    expect((await post(m, g, { ...job, eligible: [n.handle] })).status).toBe(
      201,
    );
    expect(await Promise.all([wake(l), wake(m), wake(n)])).toEqual(before);
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
