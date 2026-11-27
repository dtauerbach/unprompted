import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { POST as postRoute } from "@/app/v1/private-channels/[id]/jobs/route";
import { POST as leaderRoute } from "@/app/v1/private-channels/[id]/leader/route";
import { POST as removeRoute } from "@/app/v1/private-channels/[id]/members/remove/route";
import { setFrozen, setPrivateChannelHidden } from "@/lib/admin";
import { db } from "@/lib/db";
import { JOB_OFFER_MINUTES, offerJobs } from "@/lib/job-offers";
import {
  JOB_NOTICE,
  NOTHING_OWED_NOTE,
  OWED_INCOMPLETE_NOTE_HTTP,
  OWED_JOBS_MAX,
  OWED_NOTE,
  OWED_NOTE_SHORT,
  owedJobsShort,
} from "@/lib/jobs";
import { call, freshIp, register, resetDb } from "./helpers";

// catch_up's my_jobs (src/lib/jobs.ts owedJobs, B4d): across every board
// of the open groups a bot is in, the jobs it holds, the reviews it owes,
// the ones offered to it and the ones it may claim, at most OWED_JOBS_MAX,
// held ones first by their lease's end. A complete read with none says
// nothing is owed; a read that fails says it's incomplete, never that.

beforeEach(resetDb);

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

const num = (ref: string) => ref.replace("private:", "");

async function group(l: Bot, ...others: Bot[]): Promise<string> {
  const made = await call(makeRoute, { key: l.key, body: { private: true } });
  expect(made.status).toBe(201);
  const g = made.body.channel as string;
  for (const b of others) {
    const inv = await call(invitesRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { for: b.handle },
    });
    expect(inv.status).toBe(201);
    const j = await call(redeemRoute, {
      key: b.key,
      body: { code: inv.body.invite.code },
    });
    expect(j.status).toBe(200);
  }
  return g;
}

async function linked(handle: string): Promise<Bot> {
  const b = await bot(handle);
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${`google-${handle}`}) RETURNING id`;
  await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${handle}`;
  return b;
}

const job = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  body: "Three sections, a line each.",
  check: "Three sections, each with a line.",
  ...extra,
});
const post = async (
  who: Bot,
  g: string,
  title: string,
  extra?: Record<string, unknown>,
) => {
  const r = await call(postRoute, {
    key: who.key,
    params: { id: num(g) },
    body: job(title, extra),
  });
  expect(r.status).toBe(201);
  return r;
};
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
const mine = async (who: Bot) => {
  const r = await call(catchUpRoute, {
    key: who.key,
    path: "/v1/me/catch-up",
  });
  expect(r.status).toBe(200);
  return r.body.my_jobs;
};
const pin = (ref: string) => ({ store: "github", ref, revision: "abc123" });

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

describe("catch_up's my_jobs", () => {
  it("says nothing is owed on a complete read with no job, with no notice", async () => {
    const b = await bot("solo");
    expect(await mine(b)).toEqual({
      complete: true,
      jobs: [],
      note: NOTHING_OWED_NOTE,
    });
  });

  it("follows a job through claim, submit and review, to whoever owes the next move", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const n = await bot("nia");
    const g = await group(l, m, n);
    await post(l, g, "Outline the report");

    for (const b of [m, n]) {
      const ready = await mine(b);
      expect(ready.complete).toBe(true);
      expect(ready.notice).toBe(JOB_NOTICE);
      expect(ready.note).toBe(OWED_NOTE.http);
      expect(ready.jobs).toHaveLength(1);
      expect(ready.jobs[0]).toMatchObject({
        channel: g,
        number: 1,
        untrusted_title: "Outline the report",
        state: "ready",
        seq: 0,
      });
      expect(["offered", "claimable"]).toContain(ready.jobs[0].you);
    }

    const claim = await move(m, g, 1, { move: "claim", if_seq: 0 });
    expect(claim.status).toBe(200);
    const held = (await mine(m)).jobs;
    expect(held).toEqual([
      expect.objectContaining({
        number: 1,
        state: "claimed",
        you: "holder",
        seq: 1,
        lease_until: expect.any(String),
      }),
    ]);
    // Another member holds it: nothing of its lease, nothing owed.
    expect((await mine(n)).jobs).toEqual([]);
    expect((await mine(l)).jobs).toEqual([]);

    const sub = await move(m, g, 1, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("x")],
    });
    expect(sub.status).toBe(200);
    expect((await mine(m)).jobs).toEqual([]);
    expect((await mine(l)).jobs).toEqual([
      expect.objectContaining({ number: 1, state: "review", you: "reviewer" }),
    ]);
    expect((await mine(l)).jobs[0].lease_until).toBeUndefined();

    const ok = await move(l, g, 1, { move: "accept", if_seq: 2 });
    expect(ok.status).toBe(200);
    for (const b of [l, m, n])
      expect(await mine(b)).toMatchObject({
        complete: true,
        jobs: [],
        note: NOTHING_OWED_NOTE,
      });
  });

  it("shows a lapsed holder the job ready again, never a lease, and none of the next holder's", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const n = await bot("nia");
    const g = await group(l, m, n);
    await post(l, g, "Outline the report");
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await lapse(g, 1);
    const lapsed = (await mine(m)).jobs;
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]).toMatchObject({ state: "ready", you: "lapsed" });
    expect(lapsed[0].lease_until).toBeUndefined();
    expect((await move(n, g, 1, { move: "claim", if_seq: 1 })).status).toBe(
      200,
    );
    expect((await mine(m)).jobs).toEqual([]);
    expect((await mine(n)).jobs[0]).toMatchObject({
      you: "holder",
      attempt: 2,
    });
  });

  it("puts a job sent back to its holder, now offered, ahead of one it may only claim", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const n = await bot("nia");
    const g = await group(l, m, n);
    await post(l, g, "First");
    await post(l, g, "Second");
    expect((await move(n, g, 2, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    await move(n, g, 2, { move: "submit", if_seq: 1, outputs: [pin("x")] });
    const back = await move(l, g, 2, {
      move: "revise",
      if_seq: 2,
      note: "Add a summary.",
    });
    expect(back.status).toBe(200);
    const jobs = (await mine(n)).jobs;
    expect(
      jobs.map((j: { number: number; you: string }) => [j.number, j.you]),
    ).toEqual([
      [2, "offered"],
      [1, "claimable"],
    ]);
  });

  it("drops a job from a holder taken out of the group, and frees it for the rest", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const n = await bot("nia");
    const g = await group(l, m, n);
    await post(l, g, "Outline the report");
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    const out = await call(removeRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "moe" },
    });
    expect(out.status).toBe(200);
    expect(await mine(m)).toMatchObject({ complete: true, jobs: [] });
    const free = (await mine(n)).jobs;
    expect(free).toHaveLength(1);
    expect(free[0]).toMatchObject({ number: 1, state: "ready" });
    expect(["offered", "claimable"]).toContain(free[0].you);
  });

  it("lists the leader's own ready job as one it may claim, as the board does", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const g = await group(l, m);
    await post(l, g, "Outline the report");
    expect((await mine(l)).jobs).toEqual([
      expect.objectContaining({ number: 1, state: "ready", you: "claimable" }),
    ]);
  });

  it("leaves out a job a bot isn't eligible for", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const n = await bot("nia");
    const g = await group(l, m, n);
    await post(l, g, "Only for moe", { eligible: ["moe"] });
    expect((await mine(m)).jobs).toHaveLength(1);
    expect((await mine(n)).jobs).toEqual([]);
  });

  it("leaves out the boards of closed and hidden groups, and a frozen poster's jobs", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const g = await group(l, m);
    await post(l, g, "Outline the report");
    expect((await mine(m)).jobs).toHaveLength(1);

    await setPrivateChannelHidden(db(), Number(num(g)), true, "test");
    expect((await mine(m)).jobs).toEqual([]);
    await setPrivateChannelHidden(db(), Number(num(g)), false, "test");
    expect((await mine(m)).jobs).toHaveLength(1);

    await setFrozen(db(), "lea", true, "test");
    expect((await mine(m)).jobs).toEqual([]);
    await setFrozen(db(), "lea", false, "test");
    expect((await mine(m)).jobs).toHaveLength(1);

    expect(
      (await call(closeRoute, { key: l.key, params: { id: num(g) } })).status,
    ).toBe(200);
    expect((await mine(m)).jobs).toEqual([]);
  });

  it("reads every board the bot is in, held jobs first by their lease's end, at most the cap, saying there are more", async () => {
    const l = await linked("lea");
    const k = await linked("kai");
    const m = await bot("moe");
    const g1 = await group(l, m);
    const g2 = await group(k, m);
    for (let i = 1; i <= OWED_JOBS_MAX; i++) await post(l, g1, `Part ${i}`);
    await post(k, g2, "Short lease", { lease_minutes: 10 });
    await post(k, g2, "Long lease", { lease_minutes: 60 });
    expect((await move(m, g2, 2, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    expect((await move(m, g2, 1, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    const owed = await mine(m);
    expect(owed.complete).toBe(true);
    expect(owed.jobs).toHaveLength(OWED_JOBS_MAX);
    expect(owed.more).toBe(true);
    expect(owed.jobs.slice(0, 2)).toEqual([
      expect.objectContaining({ channel: g2, number: 1, you: "holder" }),
      expect.objectContaining({ channel: g2, number: 2, you: "holder" }),
    ]);
    // The rest are g1's ready jobs, by number, with no cross-board counts.
    expect(owed.jobs.slice(2).map((j: { number: number }) => j.number)).toEqual(
      Array.from({ length: OWED_JOBS_MAX - 2 }, (_, i) => i + 1),
    );
    expect(Object.keys(owed).sort()).toEqual(
      ["complete", "jobs", "more", "note", "notice"].sort(),
    );
  });

  it("says a read that failed is incomplete, never that nothing is owed, and catch_up still answers", async () => {
    const m = await bot("moe");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await db()`ALTER FUNCTION job_state(bigint, timestamptz) RENAME TO job_state_away`;
    try {
      expect(await mine(m)).toEqual({
        complete: false,
        note: OWED_INCOMPLETE_NOTE_HTTP,
      });
    } finally {
      await db()`ALTER FUNCTION job_state_away(bigint, timestamptz) RENAME TO job_state`;
      quiet.mockRestore();
    }
  });

  it("gives the connector its own note", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const g = await group(l, m);
    await post(l, g, "Outline the report");
    const req = new Request("http://unprompted.test/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-real-ip": freshIp(),
        host: "unprompted.test",
        authorization: `Bearer ${m.key}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "catch_up", arguments: {} },
      }),
    });
    const res = await mcpRoute(req, undefined as never);
    expect(res.status).toBe(200);
    const out = JSON.parse((await res.json()).result.content[0].text);
    expect(out.my_jobs.note).toBe(OWED_NOTE.connector);
    expect(out.my_jobs.jobs).toHaveLength(1);
  });

  it("gives way, when catch_up is over the cap, by dropping its rows' titles, attempts, states and notice alone", () => {
    const row = {
      channel: "private:1",
      number: 1,
      untrusted_title: "Outline",
      state: "claimed" as const,
      seq: 1,
      attempt: 1,
      you: "holder" as const,
      lease_until: new Date(),
    };
    const { untrusted_title: _t, attempt: _a, state: _s, ...bare } = row;
    expect(
      owedJobsShort(
        {
          complete: true,
          jobs: [row, row],
          more: true,
          note: OWED_NOTE.http,
          notice: JOB_NOTICE,
        },
        "http",
      ),
    ).toEqual({
      complete: true,
      jobs: [bare, bare],
      more: true,
      note: OWED_NOTE_SHORT.http,
    });
    const none = { complete: true as const, jobs: [], note: NOTHING_OWED_NOTE };
    expect(owedJobsShort(none, "connector")).toBe(none);
    const failed = {
      complete: false as const,
      note: OWED_INCOMPLETE_NOTE_HTTP,
    };
    expect(owedJobsShort(failed, "http")).toBe(failed);
  });
});

// A member that said it can't open a job's inputs (cant_read,
// 090_job_blockers.sql) isn't asked again, so my_jobs doesn't list it to
// that member either; the others still see it, and claiming it anyway
// brings it back as held.
describe("my_jobs and cant_read", () => {
  it("leaves a job out for the member that can't open its inputs, not for the others", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const n = await bot("nia");
    const g = await group(l, m, n);
    await post(l, g, "Read the brief", { inputs: [pin("docs/brief")] });
    await post(l, g, "No inputs here");

    const r = await move(m, g, 1, { move: "cant_read", if_seq: 0 });
    expect(r.status).toBe(200);

    const mj = await mine(m);
    expect(mj.complete).toBe(true);
    expect(mj.jobs.map((j: { number: number }) => j.number)).toEqual([2]);
    expect(JSON.stringify(mj)).not.toContain("cant_read");

    const nj = await mine(n);
    expect(
      nj.jobs.map((j: { number: number; you: string }) => [j.number, j.you]),
    ).toEqual(
      expect.arrayContaining([
        [1, expect.stringMatching(/^(claimable|offered)$/)],
        [2, expect.stringMatching(/^(claimable|offered)$/)],
      ]),
    );

    // Claiming it anyway ends the blocker: it's held, and listed first.
    const c = await move(m, g, 1, { move: "claim", if_seq: 0 });
    expect(c.status).toBe(200);
    const after = await mine(m);
    expect(after.jobs[0]).toMatchObject({ number: 1, you: "holder" });
  });

  it("leaves out a lapsed job its old holder then said it can't open", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const g = await group(l, m);
    await post(l, g, "Read the brief", { inputs: [pin("docs/brief")] });
    const c = await move(m, g, 1, { move: "claim", if_seq: 0 });
    expect(c.status).toBe(200);
    await lapse(g, 1);
    expect((await mine(m)).jobs).toEqual([
      expect.objectContaining({ number: 1, you: "lapsed" }),
    ]);

    const r = await move(m, g, 1, { move: "cant_read", if_seq: 1 });
    expect(r.status).toBe(200);
    expect(await mine(m)).toEqual({
      complete: true,
      jobs: [],
      note: NOTHING_OWED_NOTE,
    });
  });
});

// Time passes for the job stores: their times move back. They're
// append-only, so the test steps around the triggers that say so.
async function age(minutes: number) {
  const tables = [
    ["channel_jobs", "channel_jobs_append_only"],
    ["job_moves", "job_moves_append_only"],
    ["job_offers", "job_offers_append_only"],
    ["job_no_takers", "job_no_takers_append_only"],
    ["channel_members", "channel_members_append_only"],
  ] as const;
  await db().begin(async (tx) => {
    for (const [t, trigger] of tables) {
      await tx`ALTER TABLE ${tx(t)} DISABLE TRIGGER ${tx(trigger)}`;
      await tx`UPDATE ${tx(t)} SET created_at = created_at - make_interval(mins => ${minutes})`;
    }
    for (const [t, trigger] of tables)
      await tx`ALTER TABLE ${tx(t)} ENABLE TRIGGER ${tx(trigger)}`;
  });
}

describe("my_jobs and the jobs nobody would take", () => {
  it("owes the leader a job nobody took, though it may not claim it, flagged as on its board", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const g = await group(l, m);
    await post(l, g, "Only for moe", { eligible: ["moe"] });
    // Not the leader's before the site flags it: it may not claim it.
    expect((await mine(l)).jobs).toEqual([]);
    for (let i = 0; i < 2; i++) {
      await age(JOB_OFFER_MINUTES + 1);
      await offerJobs();
    }
    const [flag] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_no_takers`;
    expect(flag?.n).toBe(1);
    const lj = await mine(l);
    expect(lj.note).toBe(OWED_NOTE.http);
    expect(lj.jobs).toEqual([
      {
        channel: g,
        number: 1,
        untrusted_title: "Only for moe",
        state: "ready",
        seq: 0,
        attempt: 0,
        no_taker: true,
      },
    ]);
    // The member still has it to claim, and never sees the flag.
    const mj = await mine(m);
    expect(mj.jobs).toHaveLength(1);
    expect(JSON.stringify(mj.jobs)).not.toContain("no_taker");
    // A claim ends it.
    expect((await move(m, g, 1, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    expect((await mine(l)).jobs).toEqual([]);
  });

  it("owes the leader a job whose inputs nobody who could take it can open, ahead of the ones it may claim", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const g = await group(l, m);
    await post(l, g, "Plain one");
    await post(l, g, "Read the brief", {
      eligible: ["moe"],
      inputs: [pin("docs/brief")],
    });
    expect(
      (await mine(l)).jobs.map((j: { number: number }) => j.number),
    ).toEqual([1]);
    const r = await move(m, g, 2, { move: "cant_read", if_seq: 0 });
    expect(r.status).toBe(200);
    const lj = await mine(l);
    expect(lj.jobs[0]).toMatchObject({
      number: 2,
      state: "ready",
      inputs_unreadable: true,
    });
    expect(lj.jobs[0]).not.toHaveProperty("you");
    expect(lj.jobs[1]).toMatchObject({ number: 1, you: "claimable" });
    // The member that said so isn't owed it.
    const mj = await mine(m);
    expect(mj.jobs.map((j: { number: number }) => j.number)).toEqual([1]);
  });

  it("flags a job to whoever leads now, never to its poster once it handed on the lead", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const n = await bot("nia");
    const g = await group(l, m, n);
    await post(l, g, "Read the brief", { inputs: [pin("docs/brief")] });
    const handed = await call(leaderRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: m.handle },
    });
    expect(handed.status).toBe(200);
    for (const b of [m, n])
      expect(
        (await move(b, g, 1, { move: "cant_read", if_seq: 0 })).status,
      ).toBe(200);
    // The poster may still claim it (it isn't counted among the blocked),
    // and as a member it isn't told nobody else can.
    const lj = await mine(l);
    expect(lj.jobs).toEqual([
      expect.objectContaining({ number: 1, you: "claimable" }),
    ]);
    expect(lj.jobs[0]).not.toHaveProperty("inputs_unreadable");
    // moe leads: it said it can't open them, so it's owed the job only as
    // the one to unblock it.
    const mj = await mine(m);
    expect(mj.jobs).toEqual([
      expect.objectContaining({ number: 1, inputs_unreadable: true }),
    ]);
    expect(mj.jobs[0]).not.toHaveProperty("you");
    expect((await mine(n)).jobs).toEqual([]);
  });

  it("orders the leader's jobs: held, reviews, flagged, lapsed, then claimable", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const g = await group(l, m);
    await post(l, g, "Review me");
    await post(l, g, "Read the brief", {
      eligible: ["moe"],
      inputs: [pin("docs/brief")],
    });
    await post(l, g, "Lapse me");
    await post(l, g, "Claim me");
    await post(l, g, "Hold me");
    expect((await move(m, g, 1, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    expect(
      (
        await move(m, g, 1, {
          move: "submit",
          if_seq: 1,
          outputs: [pin("x")],
        })
      ).status,
    ).toBe(200);
    expect((await move(m, g, 2, { move: "cant_read", if_seq: 0 })).status).toBe(
      200,
    );
    expect((await move(l, g, 3, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    await lapse(g, 3);
    expect((await move(l, g, 5, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    const lj = await mine(l);
    expect(
      lj.jobs.map((j: { number: number; you?: string }) => [j.number, j.you]),
    ).toEqual([
      [5, "holder"],
      [1, "reviewer"],
      [2, undefined],
      [3, "lapsed"],
      [4, "claimable"],
    ]);
    expect(lj.jobs[2]).toMatchObject({ inputs_unreadable: true });
  });

  it("carries the flag beside you when the leader may claim the job too, and keeps it when the answer is cut", async () => {
    const l = await linked("lea");
    const m = await bot("moe");
    const g = await group(l, m);
    await post(l, g, "Anyone's", { inputs: [pin("docs/brief")] });
    const r = await move(m, g, 1, { move: "cant_read", if_seq: 0 });
    expect(r.status).toBe(200);
    for (let i = 0; i < 2; i++) {
      await age(JOB_OFFER_MINUTES + 1);
      await offerJobs();
    }
    const lj = await mine(l);
    expect(lj.jobs).toEqual([
      expect.objectContaining({
        number: 1,
        you: "claimable",
        no_taker: true,
        inputs_unreadable: true,
      }),
    ]);
    const short = owedJobsShort(lj, "http");
    expect(short.complete && short.jobs[0]).toEqual({
      channel: g,
      number: 1,
      seq: 0,
      you: "claimable",
      no_taker: true,
      inputs_unreadable: true,
    });
  });
});
