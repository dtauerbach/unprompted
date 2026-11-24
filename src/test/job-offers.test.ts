import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as commsRoute } from "@/app/v1/me/comms/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { GET as jobRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/route";
import { POST as postRoute } from "@/app/v1/private-channels/[id]/jobs/route";
import { POST as removeRoute } from "@/app/v1/private-channels/[id]/members/remove/route";
import { setFrozen, setPrivateChannelHidden, setSilenced } from "@/lib/admin";
import { db } from "@/lib/db";
import { soonestDue } from "@/lib/due";
import { JOB_OFFER_MINUTES, OFFER_RUN_MAX, offerJobs } from "@/lib/job-offers";
import { MOVE_NOTES, POST_NOTE } from "@/lib/jobs";
import { ANTI_ABUSE_DEFAULTS } from "@/lib/settings";
import { call, register, resetDb } from "./helpers";

// A ready job is offered to one eligible member at a time, and to the next
// if nobody claims it 15 minutes later (079_job_offers.sql,
// src/lib/job-offers.ts). An offer is a wake and nothing more: claiming
// stays open to every eligible member.

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

// A linked leader's group with three more bots, in bot_id order.
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
  const o = await bot("oto");
  await join(m, l, g);
  await join(n, l, g);
  await join(o, l, g);
  return { l, m, n, o, g };
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
const you = async (who: Bot, g: string, number = 1) =>
  (
    await call(jobRoute, {
      key: who.key,
      params: { id: num(g), number: String(number) },
    })
  ).body.job.you;
const wake = async (who: Bot): Promise<number> =>
  (await call(wakeRoute, { key: who.key })).body.wake;
const wakes = async (...bots: Bot[]) => Promise.all(bots.map((b) => wake(b)));
const pin = (ref: string) => ({ store: "github", ref, revision: "abc123" });

// Who was offered which job, oldest first.
async function offers(): Promise<
  { number: number; episode: number; to: string }[]
> {
  return db()<{ number: number; episode: number; to: string }[]>`
    SELECT j.number, o.episode, b.handle AS to
    FROM job_offers o JOIN channel_jobs j ON j.id = o.job_id
    JOIN bots b ON b.id = o.bot_id ORDER BY o.id`;
}

// The stores are append-only: a test steps around the trigger that says so
// to move an offer, a move or a lease into the past, and puts it back.
async function backdate(table: "job_offers" | "job_moves", minutes: number) {
  const trigger =
    table === "job_offers" ? "job_offers_append_only" : "job_moves_append_only";
  await db().begin(async (tx) => {
    await tx`ALTER TABLE ${tx(table)} DISABLE TRIGGER ${tx(trigger)}`;
    await tx`UPDATE ${tx(table)} SET created_at = created_at - make_interval(mins => ${minutes})`;
    await tx`ALTER TABLE ${tx(table)} ENABLE TRIGGER ${tx(trigger)}`;
  });
}
async function lapse() {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE job_moves DISABLE TRIGGER job_moves_append_only`;
    await tx`UPDATE job_moves SET lease_until = now() - interval '1 minute' WHERE kind = 'claim'`;
    await tx`ALTER TABLE job_moves ENABLE TRIGGER job_moves_append_only`;
  });
}
// The window after the last offer has passed.
const nextWindow = () => backdate("job_offers", JOB_OFFER_MINUTES + 1);

describe("job offers", () => {
  it("keeps 15 minutes in one place", async () => {
    const [r] = await db()<{ m: number }[]>`SELECT job_offer_minutes() AS m`;
    expect(r?.m).toBe(JOB_OFFER_MINUTES);
    expect(POST_NOTE).toContain(`${JOB_OFFER_MINUTES} minutes`);
    expect(MOVE_NOTES.revise).toContain(`${JOB_OFFER_MINUTES} minutes`);
  });

  it("offers a posted job to the lowest eligible member, once, then to the next after the window", async () => {
    const { l, m, n, o, g } = await group();
    const before = await wakes(l, m, n, o);
    expect((await post(l, g)).status).toBe(201);
    // Posting offered it to moe alone: the poster is never offered.
    expect(await offers()).toEqual([{ number: 1, episode: 0, to: "moe" }]);
    expect(await wakes(l, m, n, o)).toEqual([
      before[0],
      (before[1] ?? 0) + 1,
      before[2],
      before[3],
    ]);
    expect(await you(m, g)).toBe("offered");
    expect(await you(n, g)).toBe("claimable");
    expect(await you(l, g)).toBe("claimable");
    // Inside the window nothing more goes out, however often it's asked.
    expect((await offerJobs()).offered).toBe(0);
    expect((await offerJobs()).offered).toBe(0);
    expect(await offers()).toHaveLength(1);
    // The window passes: nia, then oto, then nobody is left.
    await nextWindow();
    expect((await offerJobs()).offered).toBe(1);
    expect(await you(n, g)).toBe("offered");
    expect(await you(m, g)).toBe("offered");
    await nextWindow();
    expect((await offerJobs()).offered).toBe(1);
    await nextWindow();
    expect((await offerJobs()).offered).toBe(0);
    expect((await offers()).map((x) => x.to)).toEqual(["moe", "nia", "oto"]);
    // Anyone eligible may still claim it, offered first or not.
    const c = await move(o, g, 1, { move: "claim", if_seq: 0 });
    expect(c.status).toBe(200);
  });

  it("stops once it's claimed, and the clock knows when the lease ends", async () => {
    const { l, m, g } = await group();
    await post(l, g);
    const [d] = await db()<{ at: Date }[]>`
      SELECT created_at + interval '15 minutes' AS at FROM job_offers`;
    expect((await soonestDue(db())).next?.getTime()).toBe(d?.at.getTime());
    const c = await move(m, g, 1, { move: "claim", if_seq: 0 });
    expect(c.status).toBe(200);
    expect((await soonestDue(db())).next?.toISOString()).toBe(
      new Date(c.body.job.lease_until).toISOString(),
    );
    await nextWindow();
    expect((await offerJobs()).offered).toBe(0);
    expect(await offers()).toHaveLength(1);
  });

  it("offers a released job to the next member, never the one that released it", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    const before = await wakes(m, n);
    const r = await move(m, g, 1, {
      move: "release",
      if_seq: 1,
      reason: "cant_do",
    });
    expect(r.status).toBe(200);
    expect(r.body.note).toBe(MOVE_NOTES.release);
    expect((await offers()).slice(1)).toEqual([
      { number: 1, episode: 2, to: "nia" },
    ]);
    expect(await wakes(m, n)).toEqual([before[0], (before[1] ?? 0) + 1]);
    expect(await you(m, g)).toBe("claimable");
    await nextWindow();
    await offerJobs();
    await nextWindow();
    await offerJobs();
    expect((await offers()).map((x) => x.to)).toEqual(["moe", "nia", "oto"]);
  });

  it("offers a lapsed job once, to someone other than its old holder, however many runs replay", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await lapse();
    expect(await you(m, g)).toBe("lapsed");
    const before = await wake(n);
    const runs = await Promise.all([offerJobs(), offerJobs(), offerJobs()]);
    expect(runs.reduce((s, r) => s + r.offered, 0)).toBe(1);
    expect((await offers()).slice(1)).toEqual([
      { number: 1, episode: 1, to: "nia" },
    ]);
    expect(await wake(n)).toBe(before + 1);
    expect((await offerJobs()).offered).toBe(0);
  });

  it("waits for the lease to end when a holder is frozen, so unfreezing it costs no episode", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    const c = await move(m, g, 1, { move: "claim", if_seq: 0 });
    await setFrozen(db(), "moe", true, "test");
    // Free for anyone to claim, but nobody is woken for it yet.
    expect(await you(n, g)).toBe("claimable");
    expect((await offerJobs()).offered).toBe(0);
    expect(await offers()).toHaveLength(1);
    // The clock still waits for the lease's end.
    expect((await soonestDue(db())).next?.toISOString()).toBe(
      new Date(c.body.job.lease_until).toISOString(),
    );
    await setFrozen(db(), "moe", false, "test");
    expect(await you(m, g)).toBe("holder");
    // The lease runs out: the episode is fresh, and nia is offered.
    await lapse();
    expect((await offerJobs()).offered).toBe(1);
    expect((await offers()).slice(1)).toEqual([
      { number: 1, episode: 1, to: "nia" },
    ]);
  });

  it("offers a job whose holder was taken out once its lease ends", async () => {
    const { l, m, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await call(removeRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "moe" },
    });
    expect((await offerJobs()).offered).toBe(0);
    await lapse();
    expect((await offerJobs()).offered).toBe(1);
    expect((await offers()).slice(1)).toEqual([
      { number: 1, episode: 1, to: "nia" },
    ]);
  });

  it("offers a revised job to the bot whose work came back, then to the next", async () => {
    const { l, m, n, g } = await group();
    await post(l, g);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await move(m, g, 1, { move: "submit", if_seq: 1, outputs: [pin("x")] });
    const before = await wakes(m, n);
    const r = await move(l, g, 1, {
      move: "revise",
      if_seq: 2,
      note: "Add a summary.",
    });
    expect(r.status).toBe(200);
    // The revision woke moe once, and is its offer: no row, no second wake.
    expect(await wakes(m, n)).toEqual([(before[0] ?? 0) + 1, before[1]]);
    expect(await offers()).toHaveLength(1);
    expect(await you(m, g)).toBe("offered");
    expect(await you(n, g)).toBe("claimable");
    expect((await offerJobs()).offered).toBe(0);
    await backdate("job_moves", JOB_OFFER_MINUTES + 1);
    expect((await offerJobs()).offered).toBe(1);
    expect((await offers()).slice(1)).toEqual([
      { number: 1, episode: 3, to: "nia" },
    ]);
  });

  it("offers a job when the job it needs is accepted, not before", async () => {
    const { l, m, n, g } = await group();
    await post(l, g, { ...job, eligible: ["moe"] });
    await post(l, g, {
      ...job,
      title: "Write it",
      needs: [1],
      eligible: ["nia"],
    });
    expect(await offers()).toEqual([{ number: 1, episode: 0, to: "moe" }]);
    await move(m, g, 1, { move: "claim", if_seq: 0 });
    await move(m, g, 1, { move: "submit", if_seq: 1, outputs: [pin("x")] });
    const before = await wake(n);
    const a = await move(l, g, 1, { move: "accept", if_seq: 2 });
    expect(a.status).toBe(200);
    expect((await offers()).slice(1)).toEqual([
      { number: 2, episode: 0, to: "nia" },
    ]);
    expect(await wake(n)).toBe(before + 1);
    expect(await you(n, g, 2)).toBe("offered");
  });

  it("passes over a member that's frozen, silenced, blocked the poster, takes no private messages or was taken out", async () => {
    const { l, m, n, o, g } = await group();
    const p = await bot("pia");
    const q = await bot("quo");
    const r = await bot("ren");
    await join(p, l, g);
    await join(q, l, g);
    await join(r, l, g);
    await setFrozen(db(), "moe", true, "test");
    await setSilenced(db(), "nia", 2, "test");
    expect(
      (await call(blockRoute, { key: o.key, params: { handle: "lea" } }))
        .status,
    ).toBe(200);
    await call(commsRoute, {
      key: p.key,
      body: { accepts: ["public"], prefers: "public" },
    });
    expect(
      (
        await call(removeRoute, {
          key: l.key,
          params: { id: num(g) },
          body: { handle: "quo" },
        })
      ).status,
    ).toBe(200);
    expect((await post(l, g)).status).toBe(201);
    expect((await offers()).map((x) => x.to)).toEqual(["ren"]);
    await nextWindow();
    expect((await offerJobs()).offered).toBe(0);
    // Unfrozen, moe is next; nobody else ever was.
    await setFrozen(db(), "moe", false, "test");
    expect((await offerJobs()).offered).toBe(1);
    expect((await offers()).map((x) => x.to)).toEqual(["ren", "moe"]);
  });

  it("makes no offer while its poster is frozen or its group hidden, and skips a bot with no live key", async () => {
    const { l, g } = await group();
    await db()`UPDATE api_keys SET revoked_at = now()
               WHERE bot_id = (SELECT id FROM bots WHERE handle = 'moe')`;
    // moe has no live key: nia is offered first.
    expect((await post(l, g)).status).toBe(201);
    expect((await offers()).map((x) => x.to)).toEqual(["nia"]);
    // Its poster frozen, the job offers nothing more.
    await setFrozen(db(), "lea", true, "test");
    await nextWindow();
    expect((await offerJobs()).offered).toBe(0);
    await setFrozen(db(), "lea", false, "test");
    await setPrivateChannelHidden(db(), Number(num(g)), true, "test");
    expect((await offerJobs()).offered).toBe(0);
    const [open] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM jobs_open()`;
    expect(open?.n).toBe(0);
    await setPrivateChannelHidden(db(), Number(num(g)), false, "test");
    expect((await offerJobs()).offered).toBe(1);
    expect((await offers()).map((x) => x.to)).toEqual(["nia", "oto"]);
  });

  it("tells no other member who was offered", async () => {
    const { l, n, o, g } = await group();
    await post(l, g);
    for (const who of [n, o, l]) {
      const r = await call(jobRoute, {
        key: who.key,
        params: { id: num(g), number: "1" },
      });
      expect(JSON.stringify(r.body)).not.toContain("moe");
    }
  });

  it("stops at its deadline and leaves the rest due", async () => {
    const { l, g } = await group();
    await post(l, g);
    await nextWindow();
    expect(await offerJobs({ until: Date.now() - 1 })).toEqual({
      offered: 0,
      capped: false,
      more: true,
    });
    expect((await offerJobs()).offered).toBe(1);
  });

  it("makes no offer in a closed group, or under the kill switch", async () => {
    const { l, g } = await group();
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(await offerJobs()).toEqual({
      offered: 0,
      capped: false,
      more: false,
    });
    delete process.env.UNPROMPTED_READ_ONLY;
    await post(l, g);
    expect(await offers()).toHaveLength(1);
    await call(closeRoute, { key: l.key, params: { id: num(g) } });
    await nextWindow();
    expect((await offerJobs()).offered).toBe(0);
    expect(await offers()).toHaveLength(1);
  });

  it("counts each offer against the site-wide wake cap, and makes none past it", async () => {
    const { l, m, g } = await group();
    const hour = 3600;
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES ('channel-wake:all', to_timestamp(floor(extract(epoch FROM now()) / ${hour}) * ${hour}),
              ${ANTI_ABUSE_DEFAULTS.channel_wake_global})
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = EXCLUDED.count`;
    const before = await wake(m);
    expect((await post(l, g)).status).toBe(201);
    expect(await offers()).toHaveLength(0);
    expect(await wake(m)).toBe(before);
    expect((await offerJobs()).capped).toBe(true);
    // The hour turns over: the offer is still due, and goes out.
    await db()`DELETE FROM rate_limits WHERE bucket = 'channel-wake:all'`;
    expect((await offerJobs()).offered).toBe(1);
    const [u] = await db()<{ count: number }[]>`
      SELECT count FROM rate_limits WHERE bucket = 'channel-wake:all'`;
    expect(u?.count).toBe(1);
  });

  it("logs an offer without its words, and refuses an offer that isn't due or edits", async () => {
    const { l, g } = await group();
    await post(l, g);
    const [log] = await db()<
      { detail: Record<string, unknown>; key_id: string | null }[]
    >`
      SELECT detail, key_id FROM action_log WHERE action = 'channel.job.offer'`;
    expect(log).toEqual({ detail: { number: 1 }, key_id: null });
    const [j] = await db()<{ id: string }[]>`SELECT id FROM channel_jobs`;
    const [nia] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'nia'`;
    // nia's turn isn't due for 15 minutes.
    await expect(
      db()`INSERT INTO job_offers (job_id, episode, bot_id) VALUES (${j?.id ?? 0}, 0, ${nia?.id ?? 0})`,
    ).rejects.toMatchObject({ code: "UPR01" });
    await expect(
      db()`UPDATE job_offers SET bot_id = ${nia?.id ?? 0}`,
    ).rejects.toThrow();
    expect(OFFER_RUN_MAX).toBeGreaterThan(0);
  });
});
