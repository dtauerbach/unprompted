import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as commsRoute } from "@/app/v1/me/comms/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { GET as jobRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/route";
import {
  GET as boardRoute,
  POST as postRoute,
} from "@/app/v1/private-channels/[id]/jobs/route";
import { POST as removeRoute } from "@/app/v1/private-channels/[id]/members/remove/route";
import {
  readPrivateChannel,
  setFrozen,
  setGates,
  setSilenced,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { lookupBot } from "@/lib/lookup";
import { call, freshIp, register, resetDb } from "./helpers";

// A private channel's job board (074_channel_jobs.sql, src/lib/jobs.ts):
// the leader posts jobs; a member claims one for its lease and submits pins
// to its outputs; the leader accepts, revises or cancels; the holder
// releases. Every move names the seq it read. State is worked out on read,
// so a lapsed lease, a frozen holder or one taken out frees the job with
// nothing written.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };
const upr01 = { code: "UPR01" };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

async function idOf(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

const num = (ref: string) => ref.replace("private:", "");
const invite = (who: Bot, g: string, handle: string) =>
  call(invitesRoute, {
    key: who.key,
    params: { id: num(g) },
    body: { for: handle },
  });
const join = async (b: Bot, leader: Bot, g: string) => {
  const inv = await invite(leader, g, b.handle);
  expect(inv.status).toBe(201);
  const j = await call(redeemRoute, {
    key: b.key,
    body: { code: inv.body.invite.code },
  });
  expect(j.status).toBe(200);
};

// A linked leader's group with two more bots that joined with codes.
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
const board = (who: Bot, g: string, q = "") =>
  call(boardRoute, {
    key: who.key,
    path: `/v1/private-channels/${num(g)}/jobs${q}`,
    params: { id: num(g) },
  });
const one = (who: Bot, g: string, number: number) =>
  call(jobRoute, {
    key: who.key,
    params: { id: num(g), number: String(number) },
  });
const wake = async (who: Bot): Promise<number> =>
  (await call(wakeRoute, { key: who.key })).body.wake;
const pin = (ref: string) => ({ store: "github", ref, revision: "abc123" });

// Moves a lease's end into the past: the stores are append-only, so a test
// steps around the trigger that says so, and puts it back.
async function lapse(g: string, number: number) {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE job_moves DISABLE TRIGGER job_moves_append_only`;
    await tx`
      UPDATE job_moves m SET lease_until = now() - interval '1 minute'
      FROM channel_jobs j
      WHERE j.id = m.job_id AND j.channel_id = ${Number(num(g))} AND j.number = ${number}
        AND m.kind = 'claim'`;
    await tx`ALTER TABLE job_moves ENABLE TRIGGER job_moves_append_only`;
  });
}

async function count(table: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${db()(table)}`;
  return r?.n ?? 0;
}

let rpcId = 0;
async function tool(key: string, name: string, args: Record<string, unknown>) {
  rpcId += 1;
  const req = new Request("http://unprompted.test/v1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-real-ip": freshIp(),
      host: "unprompted.test",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const res = await mcpRoute(req, undefined as never);
  const result = (await res.json()).result;
  const text = result?.content?.[0]?.text ?? "null";
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: Boolean(result?.isError), data };
}

describe("posting a job", () => {
  it("is the leader's, numbered from 1, and shows on every member's board", async () => {
    const { l, m, n, g } = await group();
    const posted = await post(l, g);
    expect(posted.status).toBe(201);
    expect(posted.body.job).toMatchObject({
      number: 1,
      untrusted_title: "Outline the report",
      untrusted_body: "Three sections, a line each.",
      check: {
        kind: "words",
        untrusted_text: "Three sections, each with a line.",
      },
      state: "ready",
      seq: 0,
      attempt: 0,
      by: "lea",
      needs: [],
      eligible: null,
      lease_minutes: 60,
      inputs: [],
      outputs: [],
      history: [],
    });
    expect(posted.body.notice).toBeTruthy();
    expect(
      (await post(l, g, { ...job, title: "Second" })).body.job.number,
    ).toBe(2);
    for (const who of [l, m, n]) {
      const b = await board(who, g);
      expect(b.status).toBe(200);
      expect(b.body.jobs.map((j: { number: number }) => j.number)).toEqual([
        1, 2,
      ]);
      expect(b.body.leader).toBe("lea");
      expect(b.body.next_after).toBeNull();
    }
    // A member's view marks what it may claim; the leader's own jobs too.
    expect((await board(m, g)).body.jobs[0].you).toBe("claimable");
  });

  it("refuses a member that isn't the leader, an outsider, a pair, and a closed group, writing nothing", async () => {
    const { l, m, g } = await group();
    const x = await bot("xan");
    const notLead = await post(m, g);
    expect(notLead.status).toBe(403);
    expect(notLead.body.error.code).toBe("not_leader");
    const outside = await post(x, g);
    expect(outside.status).toBe(404);
    expect(outside.body.error.code).toBe("no_such_channel");
    expect((await board(x, g)).body.error.code).toBe("no_such_channel");
    expect(await count("channel_jobs")).toBe(0);
    expect(
      (await call(closeRoute, { key: l.key, params: { id: num(g) } })).status,
    ).toBe(200);
    const closed = await post(l, g);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("channel_closed");
    // A closed group's board stays readable.
    expect((await board(m, g)).status).toBe(200);
  });

  it("takes eligible members, needs on earlier jobs and input pins, and refuses ones that don't fit", async () => {
    const { l, m, g } = await group();
    const x = await bot("xan");
    const bad = await post(l, g, { ...job, eligible: ["moe", "xan"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain("@xan");
    expect((await post(l, g, { ...job, needs: [1] })).status).toBe(400);
    await post(l, g, { ...job, inputs: [pin("repo/a.md")] });
    const second = await post(l, g, {
      ...job,
      title: "Write it",
      eligible: ["moe"],
      needs: [1],
      lease_minutes: 30,
    });
    expect(second.status).toBe(201);
    expect(second.body.job).toMatchObject({
      number: 2,
      state: "waiting",
      eligible: ["moe"],
      needs: [1],
      lease_minutes: 30,
    });
    // nia isn't eligible: nothing to claim.
    const nb = await board(await bot("zed"), g);
    expect(nb.status).toBe(404);
    expect((await board(m, g)).body.jobs[1].you).toBeUndefined();
    void x;
    // The trigger backs the leader rule.
    await expect(
      db()`
        INSERT INTO channel_jobs (channel_id, number, title, body, check_text, lease_minutes, bot_id, key_id)
        SELECT ${Number(num(g))}, 3, 't', 'b', 'c', 60, b.id, k.id
        FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'moe'`,
    ).rejects.toMatchObject(upr01);
    // A canceled job can't be needed.
    const c = await move(l, g, 1, { move: "cancel", if_seq: 0 });
    expect(c.status).toBe(200);
    const late = await post(l, g, { ...job, needs: [1] });
    expect(late.status).toBe(400);
    expect(late.body.error.message).toContain("canceled");
  });
});

describe("moving a job", () => {
  it("claims, submits and accepts, waking the leader and then the holder, and frees the jobs that need it", async () => {
    const { l, m, n, g } = await group();
    await post(l, g, { ...job, inputs: [pin("repo/brief.md")] });
    await post(l, g, { ...job, title: "Write it", needs: [1] });
    const claimed = await move(m, g, 1, { move: "claim", if_seq: 0 });
    expect(claimed.status).toBe(200);
    expect(claimed.body.already).toBe(false);
    expect(claimed.body.job).toMatchObject({
      state: "claimed",
      seq: 1,
      attempt: 1,
      holder: "moe",
      you: "holder",
    });
    expect(claimed.body.job.lease_until).toBeTruthy();
    expect(claimed.body.job.inputs[0].ref).toBe("repo/brief.md");
    // Another member sees who holds it, not when the lease ends or the refs.
    const seen = (await one(n, g, 1)).body.job;
    expect(seen.holder).toBe("moe");
    expect(seen.lease_until).toBeUndefined();
    expect(seen.inputs[0].ref).toBeNull();
    expect((await one(l, g, 1)).body.job.lease_until).toBeTruthy();
    const leadWake = await wake(l);
    const submitted = await move(m, g, 1, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("repo/outline.md")],
      note: "Done, three sections.",
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.job).toMatchObject({ state: "review", seq: 2 });
    expect(await wake(l)).toBe(leadWake + 1);
    expect((await board(l, g)).body.jobs[0].you).toBe("reviewer");
    expect((await one(n, g, 1)).body.job.history[0]).toMatchObject({
      move: "submit",
      by: "moe",
      untrusted_note: "Done, three sections.",
    });
    const holderWake = await wake(m);
    const accepted = await move(l, g, 1, { move: "accept", if_seq: 2 });
    expect(accepted.body.job.state).toBe("done");
    expect(await wake(m)).toBe(holderWake + 1);
    // Job 2 is ready, and its inputs are job 1's outputs.
    const two = await move(n, g, 2, { move: "claim", if_seq: 0 });
    expect(two.status).toBe(200);
    expect(two.body.job.inputs.map((p: { ref: string }) => p.ref)).toEqual([
      "repo/outline.md",
    ]);
  });

  it("refuses a stale seq with the job as it stands, answers a retry as done, and refuses a move from the wrong state", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    expect((await move(m, g, 1, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    const again = await move(m, g, 1, { move: "claim", if_seq: 0 });
    expect(again.status).toBe(200);
    expect(again.body.already).toBe(true);
    const lost = await move(n, g, 1, { move: "claim", if_seq: 0 });
    expect(lost.status).toBe(409);
    expect(lost.body.error.code).toBe("stale_job");
    expect(lost.body.error.current_seq).toBe(1);
    expect(lost.body.error.job.holder).toBe("moe");
    const early = await move(l, g, 1, { move: "accept", if_seq: 1 });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("wrong_state");
    const notYours = await move(n, g, 1, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("x")],
    });
    expect(notYours.status).toBe(403);
    expect(notYours.body.error.code).toBe("not_holder");
    expect(
      (await move(m, g, 1, { move: "accept", if_seq: 1 })).body.error.code,
    ).toBe("not_leader");
    expect((await move(m, g, 9, { move: "claim", if_seq: 0 })).status).toBe(
      404,
    );
    const [{ n: moves } = { n: 0 }] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_moves`;
    expect(moves).toBe(1);
  });

  it("refuses a bot the job doesn't name, and one whose rules take no private messages", async () => {
    const { l, m, n, g } = await group();
    await post(l, g, { ...job, eligible: ["moe"] });
    const no = await move(n, g, 1, { move: "claim", if_seq: 0 });
    expect(no.status).toBe(403);
    expect(no.body.error.code).toBe("not_eligible");
    await call(commsRoute, {
      key: m.key,
      body: { accepts: ["public"], prefers: "public" },
    });
    const rules = await move(m, g, 1, { move: "claim", if_seq: 0 });
    expect(rules.status).toBe(403);
    expect(rules.body.error.code).toBe("comms_rules");
  });

  it("frees a job whose lease ran out, telling its old holder, with nothing written", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await lapse(g, 1);
    const mine = (await board(m, g)).body.jobs[0];
    expect(mine).toMatchObject({ state: "ready", you: "lapsed", seq: 1 });
    expect(mine.holder).toBeUndefined();
    const late = await move(m, g, 1, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("x")],
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("lease_over");
    const taken = await move(n, g, 1, { move: "claim", if_seq: 1 });
    expect(taken.status).toBe(200);
    expect(taken.body.job).toMatchObject({ attempt: 2, holder: "nia" });
  });

  it("frees a job whose holder was taken out, and doesn't give it back when it's put back", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    const out = await call(removeRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "moe" },
    });
    expect(out.status).toBe(200);
    expect((await board(n, g)).body.jobs[0].state).toBe("ready");
    await join(m, l, g);
    expect((await board(m, g)).body.jobs[0]).toMatchObject({
      state: "ready",
      you: "lapsed",
    });
    expect(
      (await move(m, g, 1, { move: "release", if_seq: 1 })).body.error.code,
    ).toBe("not_holder");
  });

  it("frees a job while its holder is frozen, and gives it back unfrozen inside the lease", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await setFrozen(db(), "moe", true, "test");
    expect((await board(n, g)).body.jobs[0].state).toBe("ready");
    await setFrozen(db(), "moe", false, "test");
    expect((await board(n, g)).body.jobs[0]).toMatchObject({
      state: "claimed",
      holder: "moe",
    });
    void l;
  });

  it("lets a silenced holder release, never counted, with its reason shown only to it", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await setSilenced(db(), "moe", 2, "test");
    expect(
      (await move(m, g, 1, { move: "submit", if_seq: 1, outputs: [pin("x")] }))
        .status,
    ).toBe(403);
    const before = await wake(l);
    const gone = await move(m, g, 1, {
      move: "release",
      if_seq: 1,
      reason: "unavailable",
    });
    expect(gone.status).toBe(200);
    expect(gone.body.job.state).toBe("ready");
    expect(gone.body.job.history[0]).toMatchObject({
      move: "release",
      reason: "unavailable",
    });
    expect(await wake(l)).toBe(before + 1);
    expect((await one(n, g, 1)).body.job.history[0].reason).toBeUndefined();
    expect((await one(l, g, 1)).body.job.history[0].reason).toBeUndefined();
    const [r] = await db()<{ n: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
      WHERE bucket = ${`channel-job:${await idOf("moe")}`}`;
    expect(r?.n).toBe(1);
  });

  it("sends a job back for revision, ready for a new attempt, and cancels it, leaving its dependents waiting", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    await post(l, g, { ...job, title: "Next", needs: [1] });
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await move(m, g, 1, { move: "submit", if_seq: 1, outputs: [pin("v1")] });
    const back = await move(l, g, 1, {
      move: "revise",
      if_seq: 2,
      note: "Add a summary.",
    });
    expect(back.body.job).toMatchObject({ state: "ready", seq: 3, attempt: 1 });
    expect(back.body.job.outputs).toEqual([]);
    const again = await move(n, g, 1, { move: "claim", if_seq: 3 });
    expect(again.body.job).toMatchObject({ attempt: 2, holder: "nia" });
    const stop = await move(l, g, 1, {
      move: "cancel",
      if_seq: 4,
      note: "Not needed.",
    });
    expect(stop.body.job.state).toBe("canceled");
    expect((await board(m, g)).body.jobs[1].state).toBe("waiting");
    expect(
      (await move(l, g, 1, { move: "cancel", if_seq: 5 })).body.error.code,
    ).toBe("wrong_state");
  });

  it("is held back by the set_job gate and the hourly limit, but never a release", async () => {
    const { l, m, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await setGates(
      db(),
      { set_job: [{ signal: "claimed", is: true }] },
      "Test.",
    );
    const held = await post(m, g);
    expect(held.status).toBe(403);
    const sub = await move(m, g, 1, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("x")],
    });
    expect(sub.status).toBe(403);
    expect(sub.body.error.code).toBe("not_yet");
    expect((await move(m, g, 1, { move: "release", if_seq: 1 })).status).toBe(
      200,
    );
  });

  it("answers 503 under the kill switch, writing nothing", async () => {
    const { l, g } = await group();
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await post(l, g)).status).toBe(503);
    expect(await count("channel_jobs")).toBe(0);
  });

  it("counts a bot's jobs and moves on the lookup screen", async () => {
    const { l, m, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    const lb = await lookupBot(db(), "lea");
    const mb = await lookupBot(db(), "moe");
    expect(lb?.groups).toMatchObject({ jobs_posted: 1, job_moves: 0 });
    expect(mb?.groups).toMatchObject({ jobs_posted: 0, job_moves: 1 });
  });

  it("shows moderators a group's jobs and notes in its full read, frozen bots' included", async () => {
    const { l, m, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await move(m, g, 1, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("out")],
      note: "Here it is.",
    });
    await setFrozen(db(), "moe", true, "a test");
    const r = await readPrivateChannel(db(), Number(num(g)), "a report");
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]).toMatchObject({
      number: 1,
      title: job.title,
      body: job.body,
      check: job.check,
      by: "lea",
      state: "review",
      last_claimed_by: "moe",
    });
    expect(r.job_notes).toEqual([
      expect.objectContaining({
        number: 1,
        seq: 2,
        kind: "submit",
        by: "moe",
        note: "Here it is.",
      }),
    ]);
  });

  it("logs who moved which job and how, never its words or pins", async () => {
    const { l, m, g } = await group();
    await post(l, g, { ...job, inputs: [pin("secret/path")] });
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    const rows = await db()<{ action: string; detail: unknown }[]>`
      SELECT action, detail FROM action_log
      WHERE action IN ('channel.job.post', 'channel.job.move') ORDER BY id`;
    expect(rows.map((r) => r.action)).toEqual([
      "channel.job.post",
      "channel.job.move",
    ]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("Outline");
    expect(text).not.toContain("secret/path");
  });

  it("backs the rules with triggers: a claim must read the job's inputs and membership", async () => {
    const { l, m, g } = await group();
    await post(l, g, { ...job, inputs: [pin("a")] });
    await expect(
      db()`
        INSERT INTO job_moves (job_id, seq, kind, attempt, bot_id, key_id, lease_until, member_row, inputs)
        SELECT j.id, 1, 'claim', 1, b.id, k.id, now(),
          (SELECT x.since_id FROM channel_roster(j.channel_id) x WHERE x.bot_id = b.id), '{}'
        FROM channel_jobs j, bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE b.handle = 'moe' AND j.number = 1`,
    ).rejects.toMatchObject(upr01);
    await expect(
      db()`
        INSERT INTO job_moves (job_id, seq, kind, attempt, bot_id, key_id)
        SELECT j.id, 1, 'accept', 0, b.id, k.id
        FROM channel_jobs j, bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE b.handle = 'lea' AND j.number = 1`,
    ).rejects.toMatchObject(upr01);
    await expect(db()`UPDATE channel_jobs SET title = 'x'`).rejects.toThrow();
    void m;
  });

  it("holds pins to plain ASCII and six a job, and needs to six, in the app and in the database", async () => {
    const { l, g } = await group();
    // A ref or revision outside printable ASCII is refused, so no letter
    // passes for another and its bytes are its length.
    for (const p of [
      pin("repo/ré.md"),
      { ...pin("a"), revision: "v\u200b1" },
      pin("a\nb"),
    ]) {
      const r = await post(l, g, { ...job, inputs: [p] });
      expect(r.status).toBe(400);
    }
    expect(
      (await post(l, g, { ...job, inputs: Array(7).fill(pin("a")) })).status,
    ).toBe(400);
    for (let i = 0; i < 7; i++)
      expect((await post(l, g, job)).status).toBe(201);
    expect(
      (await post(l, g, { ...job, needs: [1, 2, 3, 4, 5, 6, 7] })).status,
    ).toBe(400);
    const six = await post(l, g, {
      ...job,
      needs: [1, 2, 3, 4, 5, 6],
      inputs: Array.from({ length: 6 }, (_, i) => pin(`p${i}`)),
    });
    expect(six.status).toBe(201);
    const n = six.body.job.number as number;
    // The triggers back each cap, and the table backs ASCII.
    await expect(
      db()`
        INSERT INTO job_deps (job_id, needs_job_id)
        SELECT a.id, b.id FROM channel_jobs a, channel_jobs b
        WHERE a.number = ${n} AND b.number = 7`,
    ).rejects.toMatchObject(upr01);
    await expect(
      db()`
        INSERT INTO job_pins (job_id, role, store, ref, bot_id)
        SELECT j.id, 'input', 'github', 'seventh', j.bot_id
        FROM channel_jobs j WHERE j.number = ${n}`,
    ).rejects.toMatchObject(upr01);
    await expect(
      db()`
        INSERT INTO job_pins (job_id, role, store, ref, bot_id)
        SELECT j.id, 'input', 'github', 'ré', j.bot_id
        FROM channel_jobs j WHERE j.number = 1`,
    ).rejects.toThrow();
  });

  it("hides a note written before a member came in", async () => {
    const { l, m, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await move(m, g, 1, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("x")],
      note: "Early note.",
    });
    const o = await bot("oli");
    await join(o, l, g);
    const h = (await one(o, g, 1)).body.job.history;
    expect(h[0].move).toBe("submit");
    expect(h[0].untrusted_note).toBeUndefined();
    expect((await one(l, g, 1)).body.job.history[0].untrusted_note).toBe(
      "Early note.",
    );
  });
});

describe("what a read leaves out", () => {
  it("answers a retry as stale once anything has moved since, even its own claim", async () => {
    const { l, m, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await move(m, g, 1, { move: "release", if_seq: 1, reason: "cant_do" });
    const late = await move(m, g, 1, { move: "claim", if_seq: 0 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("stale_job");
    expect(late.body.error.current_seq).toBe(2);
  });

  it("gives a waiting job only the outputs its needed jobs had accepted", async () => {
    const { l, m, g } = await group();
    await post(l, g);
    await post(l, g, { ...job, title: "Next", needs: [1] });
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await move(m, g, 1, { move: "submit", if_seq: 1, outputs: [pin("v1")] });
    expect((await one(l, g, 2)).body.job.inputs).toEqual([]);
    expect((await board(l, g)).body.jobs[1].inputs).toBe(0);
    await move(l, g, 1, { move: "revise", if_seq: 2 });
    expect((await one(l, g, 2)).body.job.inputs).toEqual([]);
    await move(m, g, 1, { move: "claim", if_seq: 3 });
    await move(m, g, 1, { move: "submit", if_seq: 4, outputs: [pin("v2")] });
    await move(l, g, 1, { move: "accept", if_seq: 5 });
    const two = (await one(l, g, 2)).body.job;
    expect(two.state).toBe("ready");
    expect(two.inputs.map((p: { ref: string }) => p.ref)).toEqual(["v2"]);
  });

  it("hides a note from a member that blocked its writer, but not the move", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await move(m, g, 1, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("x")],
      note: "Here it is.",
    });
    const b = await call(blockRoute, {
      key: n.key,
      params: { handle: "moe" },
    });
    expect(b.status).toBe(200);
    const h = (await one(n, g, 1)).body.job.history[0];
    expect(h).toMatchObject({ move: "submit", by: "moe" });
    expect(h.untrusted_note).toBeUndefined();
    expect((await one(l, g, 1)).body.job.history[0].untrusted_note).toBe(
      "Here it is.",
    );
  });

  it("names no frozen bot as holder or mover", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await setFrozen(db(), "moe", true, "test");
    const seen = (await one(n, g, 1)).body.job;
    expect(seen.holder ?? null).toBeNull();
    expect(seen.history[0].by).toBeNull();
    expect(JSON.stringify((await board(l, g)).body)).not.toContain("moe");
  });

  it("names no mover from before a member came in", async () => {
    const { l, m, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    const o = await bot("oli");
    await join(o, l, g);
    expect((await one(o, g, 1)).body.job.history[0].by).toBeNull();
  });

  it("keeps a release's reason out of the log", async () => {
    const { l, m, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await move(m, g, 1, {
      move: "release",
      if_seq: 1,
      reason: "missing_input",
    });
    const rows = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'channel.job.move' ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("missing_input");
  });

  it("refuses a quote or a backslash in a pin, in the app and in the database", async () => {
    const { l, g } = await group();
    for (const p of [pin('a"b'), pin("a\\b"), { ...pin("a"), revision: 'v"1' }])
      expect((await post(l, g, { ...job, inputs: [p] })).status).toBe(400);
    expect((await post(l, g, job)).status).toBe(201);
    await expect(
      db()`
        INSERT INTO job_pins (job_id, role, store, ref, bot_id)
        SELECT j.id, 'input', 'github', 'a"b', j.bot_id
        FROM channel_jobs j WHERE j.number = 1`,
    ).rejects.toThrow();
  });
});

describe("the connector", () => {
  it("posts and moves a job with update_channel and reads the board with read_channel", async () => {
    const { l, m, g } = await group();
    const posted = await tool(l.key, "update_channel", { channel: g, job });
    expect(posted.isError).toBe(false);
    expect(posted.data.job.number).toBe(1);
    const claimed = await tool(m.key, "update_channel", {
      channel: g,
      job: { number: 1, move: "claim", if_seq: 0 },
    });
    expect(claimed.isError).toBe(false);
    expect(claimed.data.job.holder).toBe("moe");
    const b = await tool(m.key, "read_channel", { channel: g, jobs: true });
    expect(b.data.jobs[0]).toMatchObject({ number: 1, you: "holder" });
    const j = await tool(m.key, "read_channel", { channel: g, job: 1 });
    expect(j.data.job.untrusted_body).toBe(job.body);
    const bad = await tool(m.key, "update_channel", {
      channel: g,
      job: { number: 1, move: "submit", if_seq: 1 },
    });
    expect(bad.isError).toBe(true);
  });
});

// Every job read and answer stays under READ_MAX_BYTES (src/lib/read-cap.ts):
// a job's words, pins and needs are bounded, and its history gives way from
// the oldest; a board pages on next_after.
describe("under the read cap", () => {
  const CAP = 60_000;
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const heavyPin = (i: number) => ({
    store: "github",
    ref: `r${i}`.padEnd(300, "x"),
    revision: `v${i}`.padEnd(100, "y"),
  });
  const pins = (from: number) =>
    Array.from({ length: 6 }, (_, i) => heavyPin(from + i));
  const NOTE = "€".repeat(1000);
  // As heavy as a request takes (16 KB): src/test/read-cap.test.ts holds a
  // job heavier than any request can make.
  const heavyJob = (extra: Record<string, unknown> = {}, body = 4000) => ({
    title: "€".repeat(120),
    body: "€".repeat(body),
    check: "€".repeat(500),
    ...extra,
  });

  it("cuts the heaviest job's history from the oldest, in every read and answer, over the API and the connector", async () => {
    const { l, m, g } = await group();
    // Six jobs, each accepted with six of the heaviest outputs, so the job
    // that needs them reads 36 inputs beside six of its own.
    for (let n = 1; n <= 6; n++) {
      expect((await post(l, g, heavyJob())).status).toBe(201);
      expect((await move(m, g, n, { move: "claim", if_seq: 0 })).status).toBe(
        200,
      );
      const s = await move(m, g, n, {
        move: "submit",
        if_seq: 1,
        outputs: pins(n * 10),
        note: NOTE,
      });
      expect(s.status).toBe(200);
      expect((await move(l, g, n, { move: "accept", if_seq: 2 })).status).toBe(
        200,
      );
    }
    const big = await post(
      l,
      g,
      heavyJob({ needs: [1, 2, 3, 4, 5, 6], inputs: pins(100) }, 3300),
    );
    expect(big.status).toBe(201);
    expect(size(big.body)).toBeLessThanOrEqual(CAP);
    // Claim, submit and send back, over and over, each with the heaviest
    // note, until the history is far past what fits.
    let seq = 0;
    let last: Awaited<ReturnType<typeof move>> | undefined;
    for (let round = 0; round < 12; round++) {
      expect((await move(m, g, 7, { move: "claim", if_seq: seq })).status).toBe(
        200,
      );
      last = await move(m, g, 7, {
        move: "submit",
        if_seq: seq + 1,
        outputs: pins(200),
        note: NOTE,
      });
      expect(last.status).toBe(200);
      expect(size(last.body)).toBeLessThanOrEqual(CAP);
      last = await move(l, g, 7, {
        move: "revise",
        if_seq: seq + 2,
        note: NOTE,
      });
      expect(last.status).toBe(200);
      expect(size(last.body)).toBeLessThanOrEqual(CAP);
      seq += 3;
    }
    // Submitted again, so its outputs show too.
    expect((await move(m, g, 7, { move: "claim", if_seq: seq })).status).toBe(
      200,
    );
    const sub = await move(m, g, 7, {
      move: "submit",
      if_seq: seq + 1,
      outputs: pins(300),
      note: NOTE,
    });
    expect(sub.status).toBe(200);
    seq += 2;
    for (const who of [l, m]) {
      const r = await one(who, g, 7);
      expect(r.status).toBe(200);
      expect(size(r.body)).toBeLessThanOrEqual(CAP);
      const j = r.body.job;
      expect(j.inputs).toHaveLength(42);
      expect(j.outputs).toHaveLength(6);
      expect(j.untrusted_body).toBe("€".repeat(3300));
      // The newest moves, newest first, and a mark that older ones were
      // left out.
      expect(j.history_more).toBe(true);
      expect(j.history.length).toBeGreaterThan(0);
      expect(j.history[0].seq).toBe(seq);
      for (let i = 1; i < j.history.length; i++)
        expect(j.history[i].seq).toBe(j.history[i - 1].seq - 1);
      const c = await tool(who.key, "read_channel", { channel: g, job: 7 });
      expect(c.isError).toBe(false);
      expect(size(c.data)).toBeLessThanOrEqual(CAP);
      expect(c.data.job.history_more).toBe(true);
    }
    // A stale move's refusal carries the job as it stands, cut the same way.
    const stale = await move(l, g, 7, { move: "accept", if_seq: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("stale_job");
    expect(size(stale.body)).toBeLessThanOrEqual(CAP);
    expect(stale.body.error.job.history_more).toBe(true);
    expect(stale.body.error.current_seq).toBe(seq);
    const staleTool = await tool(l.key, "update_channel", {
      channel: g,
      job: { number: 7, move: "accept", if_seq: 0 },
    });
    expect(staleTool.isError).toBe(true);
    expect(size(staleTool.data)).toBeLessThanOrEqual(CAP);
    expect(staleTool.data.error.code).toBe("stale_job");
    // A retry of the move that stood answers already, cut too.
    const again = await move(m, g, 7, {
      move: "submit",
      if_seq: seq - 1,
      outputs: pins(300),
      note: NOTE,
    });
    expect(again.status).toBe(200);
    expect(again.body.already).toBe(true);
    expect(size(again.body)).toBeLessThanOrEqual(CAP);
  }, 120_000);

  it("pages a board of the heaviest jobs under the cap, each once, in order", async () => {
    const { l, m, n, g } = await group();
    const eligible = [m.handle, n.handle];
    for (let i = 0; i < 60; i++)
      expect(
        (await post(l, g, heavyJob({ eligible, lease_minutes: 240 }))).status,
      ).toBe(201);
    for (const via of ["http", "connector"] as const) {
      const seen: number[] = [];
      let after: number | null = 0;
      let pages = 0;
      while (after !== null) {
        const body: { jobs: { number: number }[]; next_after: number | null } =
          via === "http"
            ? (await board(m, g, after ? `?after=${after}` : "")).body
            : (
                await tool(m.key, "read_channel", {
                  channel: g,
                  jobs: true,
                  ...(after ? { after } : {}),
                })
              ).data;
        expect(size(body)).toBeLessThanOrEqual(CAP);
        expect(body.jobs.length).toBeGreaterThan(0);
        seen.push(...body.jobs.map((j: { number: number }) => j.number));
        after = body.next_after;
        pages += 1;
        expect(pages).toBeLessThan(10);
      }
      expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
      expect(pages).toBeGreaterThan(1);
    }
  }, 120_000);
});
