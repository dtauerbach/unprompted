import { beforeEach, describe, expect, it } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as eventsRoute } from "@/app/v1/events/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { GET as jobRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/route";
import { POST as postRoute } from "@/app/v1/private-channels/[id]/jobs/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { POST as removeRoute } from "@/app/v1/private-channels/[id]/members/remove/route";
import { db } from "@/lib/db";
import { workDue } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { releaseBot } from "@/lib/humans";
import { JOB_OFFER_MINUTES, offerJobs } from "@/lib/job-offers";
import { call, register, resetDb } from "./helpers";

// P8 (Dot's R189, G2): a leader takes out a quiet member that holds work,
// and nothing is left waiting on it. One committed change ends its
// membership and everything it held in that group: its claim no longer
// holds, the job is offered once to a member who can take it, its session
// reminders there stop, and the group leaves its catch_up. Work it already
// handed in and the leader accepted stays, and so does everything it has in
// any other group. Taking it out again changes nothing.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

const num = (ref: string) => ref.replace("private:", "");

async function groupOf(l: Bot, ...members: Bot[]): Promise<string> {
  const made = await call(makeRoute, { key: l.key, body: { private: true } });
  expect(made.status).toBe(201);
  const g = made.body.channel as string;
  for (const b of members) {
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

const job = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  body: "A line each.",
  check: "Each part has a line.",
  ...extra,
});
const post = async (who: Bot, g: string, body: Record<string, unknown>) => {
  const r = await call(postRoute, {
    key: who.key,
    params: { id: num(g) },
    body,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.job.number as number;
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
const read = (who: Bot, g: string, number: number) =>
  call(jobRoute, {
    key: who.key,
    params: { id: num(g), number: String(number) },
  });
const remove = (l: Bot, g: string, handle: string) =>
  call(removeRoute, { key: l.key, params: { id: num(g) }, body: { handle } });
const pin = (ref: string) => ({ store: "github", ref, revision: "abc123" });

async function offersOf(g: string, number: number) {
  return db()<{ episode: number; to: string }[]>`
    SELECT o.episode, b.handle AS to
    FROM job_offers o JOIN channel_jobs j ON j.id = o.job_id
    JOIN bots b ON b.id = o.bot_id
    WHERE j.channel_id = ${Number(num(g))} AND j.number = ${number}
    ORDER BY o.id`;
}

// Every claim's lease, run out, as if its time had passed.
async function lapse() {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE job_moves DISABLE TRIGGER job_moves_append_only`;
    await tx`UPDATE job_moves SET lease_until = now() - interval '1 minute' WHERE kind = 'claim'`;
    await tx`ALTER TABLE job_moves ENABLE TRIGGER job_moves_append_only`;
  });
}
async function pastOfferWindow() {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE job_offers DISABLE TRIGGER job_offers_append_only`;
    await tx`UPDATE job_offers SET created_at = created_at - make_interval(mins => ${JOB_OFFER_MINUTES + 1})`;
    await tx`ALTER TABLE job_offers ENABLE TRIGGER job_offers_append_only`;
  });
}

// A linked bot, so it may start a private channel.
async function leader(): Promise<Bot> {
  const l = await bot("lea");
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES ('google-p8') RETURNING id`;
  await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = 'lea'`;
  return l;
}

// lea leads two groups. In the first, moe handed in job 1 and lea accepted
// it; job 2 needs job 1, and moe holds it on an active lease; a session
// meets in ten minutes. In the second, moe holds a job too.
async function scene() {
  const l = await leader();
  const m = await bot("moe");
  const n = await bot("nia");
  const o = await bot("oto");
  const g = await groupOf(l, m, n, o);
  const other = await groupOf(l, m);

  const first = await post(l, g, job("Draft"));
  expect((await move(m, g, first, { move: "claim", if_seq: 0 })).status).toBe(
    200,
  );
  expect(
    (
      await move(m, g, first, {
        move: "submit",
        if_seq: 1,
        outputs: [pin("draft.md")],
      })
    ).status,
  ).toBe(200);
  expect((await move(l, g, first, { move: "accept", if_seq: 2 })).status).toBe(
    200,
  );
  const second = await post(l, g, job("Edit", { needs: [first] }));
  const held = await move(m, g, second, { move: "claim", if_seq: 0 });
  expect(held.status).toBe(200);

  const elsewhere = await post(l, other, job("Elsewhere"));
  expect(
    (await move(m, other, elsewhere, { move: "claim", if_seq: 0 })).status,
  ).toBe(200);

  const s = await call(eventsRoute, {
    key: l.key,
    path: "/v1/events",
    body: { action: "session", channel: g, in_minutes: 10 },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return {
    l,
    m,
    n,
    o,
    g,
    other,
    first,
    second,
    elsewhere,
    meets: Date.parse(s.body.session.at),
  };
}

describe("taking out a quiet member that holds work (P8)", () => {
  it("frees its job and offers it once, at once; again changes nothing", async () => {
    const { l, n, g, second } = await scene();
    const before = await offersOf(g, second);
    const out = await remove(l, g, "moe");
    expect(out.status).toBe(200);
    // Nothing waits on moe: the job is ready, held by nobody, and one
    // member who can take it has been asked.
    const seen = (await read(n, g, second)).body.job;
    expect(seen.state).toBe("ready");
    expect(seen.holder).toBeUndefined();
    expect(seen.you).toBe("offered");
    const after = await offersOf(g, second);
    expect(after.slice(before.length)).toEqual([{ episode: 1, to: "nia" }]);

    // Taking it out again is refused and writes nothing.
    const again = await remove(l, g, "moe");
    expect(again.status).toBe(404);
    expect((await offerJobs()).offered).toBe(0);
    const [r] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM action_log WHERE action = 'channel.remove'`;
    expect(r?.n).toBe(1);

    // When moe's lease would have ended, nobody is asked twice: the lease
    // ending starts no new round of offers.
    await lapse();
    expect((await offerJobs()).offered).toBe(0);
    expect(await offersOf(g, second)).toEqual(after);
    // The window passes and the next member is asked, once.
    await pastOfferWindow();
    expect((await offerJobs()).offered).toBe(1);
    expect((await offersOf(g, second)).slice(after.length)).toEqual([
      { episode: 1, to: "oto" },
    ]);
  });

  it("leaves its old attempt no effect, and the job to whoever takes it next", async () => {
    const { l, m, n, g, first, second } = await scene();
    await remove(l, g, "moe");
    // moe can't hand in or give up what it held: the group isn't its now.
    const late = await move(m, g, second, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("late.md")],
    });
    expect(late.status).toBe(404);
    expect(late.body.error.code).toBe("no_such_channel");
    // nia takes it, and reads job 1's accepted output as its input.
    const take = await move(n, g, second, { move: "claim", if_seq: 1 });
    expect(take.status, JSON.stringify(take.body)).toBe(200);
    expect(take.body.job).toMatchObject({ attempt: 2, holder: "nia" });
    const full = (await read(n, g, second)).body.job;
    expect(full.inputs).toEqual([
      expect.objectContaining({ ref: "draft.md", revision: "abc123" }),
    ]);
    // The work moe handed in before it went stays accepted, its output
    // still there for the leader.
    const done = (await read(l, g, first)).body.job;
    expect(done.state).toBe("done");
    expect(done.outputs).toEqual([
      expect.objectContaining({ ref: "draft.md" }),
    ]);
  });

  it("changes nothing in its other groups", async () => {
    const { l, m, g, other, elsewhere } = await scene();
    await remove(l, g, "moe");
    const there = (await read(m, other, elsewhere)).body.job;
    expect(there).toMatchObject({ state: "claimed", holder: "moe" });
    expect(there.you).toBe("holder");
  });

  it("stops its reminders there and drops the group from its catch_up", async () => {
    const { l, m, g, other, meets } = await scene();
    await remove(l, g, "moe");
    await workDue(new Date(meets));
    const fired = await db()<{ handle: string }[]>`
      SELECT b.handle FROM event_fires f JOIN bots b ON b.id = f.bot_id
      WHERE f.kind = 'session' AND f.outcome = 'fired' ORDER BY b.handle`;
    expect(fired.map((x) => x.handle)).toEqual(["lea", "nia", "oto"]);

    const cu = await call(catchUpRoute, { key: m.key });
    expect(cu.status).toBe(200);
    const text = JSON.stringify(cu.body);
    const groups = (cu.body.digest?.groups ?? cu.body.groups ?? []) as {
      channel: string;
    }[];
    expect(groups.map((x) => x.channel)).toEqual([other]);
    // Nothing left that points it back at the group it left.
    expect(text).not.toContain(`"${g}"`);
  });
});

describe("taking out the only member that could take it", () => {
  it("tells the leader at once that nobody can take the job", async () => {
    const l = await leader();
    const m = await bot("moe");
    const g = await groupOf(l, m);
    const n = await post(l, g, job("Draft"));
    expect((await move(m, g, n, { move: "claim", if_seq: 0 })).status).toBe(
      200,
    );
    expect((await read(l, g, n)).body.job.no_taker).toBeUndefined();
    expect((await remove(l, g, "moe")).status).toBe(200);
    const seen = (await read(l, g, n)).body.job;
    expect(seen.state).toBe("ready");
    expect(seen.no_taker).toBe(true);
    // Its own removal did it, so the mark comes with no wake.
    const [w] = await db()<
      { woken: boolean }[]
    >`SELECT woken FROM job_no_takers`;
    expect(w?.woken).toBe(false);
  });

  it("wakes the leader at once when the last one leaves by itself", async () => {
    const l = await leader();
    const m = await bot("moe");
    const g = await groupOf(l, m);
    const n = await post(l, g, job("Draft"));
    await move(m, g, n, { move: "claim", if_seq: 0 });
    const out = await call(leaveRoute, { key: m.key, params: { id: num(g) } });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect((await read(l, g, n)).body.job.no_taker).toBe(true);
    const [w] = await db()<
      { woken: boolean }[]
    >`SELECT woken FROM job_no_takers`;
    expect(w?.woken).toBe(true);
  });

  it("wakes the leader at once when the last one's person ends its link", async () => {
    const l = await leader();
    const m = await bot("moe");
    const g = await groupOf(l, m);
    const n = await post(l, g, job("Draft"));
    await move(m, g, n, { move: "claim", if_seq: 0 });
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-moe') RETURNING id`;
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${m.handle}`;
    await releaseBot(db(), "google-moe", m.handle, null);
    // A person ended it, not the leader: a wake, and no failure for the moderators.
    expect((await read(l, g, n)).body.job.no_taker).toBe(true);
    const [w] = await db()<
      { woken: boolean }[]
    >`SELECT woken FROM job_no_takers`;
    expect(w?.woken).toBe(true);
    const alerts = await db()`
      SELECT 1 FROM action_log WHERE action = 'alert.job_offers_failed'`;
    expect(alerts.length).toBe(0);
  });
});

describe("a holder that goes another way", () => {
  it("offers its job at once when it leaves by itself", async () => {
    const { m, n, g, second } = await scene();
    const out = await call(leaveRoute, { key: m.key, params: { id: num(g) } });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect((await read(n, g, second)).body.job.you).toBe("offered");
  });

  it("offers its job at once when its person ends its link", async () => {
    const { m, n, g, second } = await scene();
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-moe') RETURNING id`;
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${m.handle}`;
    await releaseBot(db(), "google-moe", m.handle, null);
    expect((await read(n, g, second)).body.job.you).toBe("offered");
  });

  it("is still passed over when it's put back before the offer comes round", async () => {
    const { l, m, g, second } = await scene();
    // moe was offered it when it was posted, and claimed it.
    const before = (await offersOf(g, second)).length;
    await remove(l, g, "moe");
    const inv = await call(invitesRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { for: "moe" },
    });
    expect(inv.status).toBe(201);
    const back = await call(redeemRoute, {
      key: m.key,
      body: { code: inv.body.invite.code },
    });
    expect(back.status).toBe(200);
    for (let i = 0; i < 2; i += 1) {
      await pastOfferWindow();
      await offerJobs();
    }
    expect((await offersOf(g, second)).slice(before).map((o) => o.to)).toEqual([
      "nia",
      "oto",
    ]);
    expect((await read(m, g, second)).body.job.you).toBe("lapsed");
  });

  it("frozen, then taken out, is offered from the removal", async () => {
    const { l, n, g, second } = await scene();
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'moe'`;
    expect((await offerJobs()).offered).toBe(0);
    await remove(l, g, "moe");
    expect((await read(n, g, second)).body.job.you).toBe("offered");
  });
});
