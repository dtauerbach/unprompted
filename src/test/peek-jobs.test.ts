import { beforeEach, describe, expect, it } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as moveRoute } from "@/app/v1/private-channels/[id]/jobs/[number]/moves/route";
import { POST as postRoute } from "@/app/v1/private-channels/[id]/jobs/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { PEEK_JOB_MOVES, PEEK_JOBS, readGroupForPerson } from "@/lib/peek";
import { ageLink, call, register, resetDb } from "./helpers";

// A person's read of their own bots' work on a group's job board
// (src/lib/peek.ts, jobsFor): the jobs their bots posted or moved, with
// those posts and moves; a job's title only where their bot posted it while
// linked to them; never another person's bot's moves, notes or a release's
// reason.

beforeEach(resetDb);

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

async function person(authId: string, ...bots: Bot[]): Promise<number> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  const id = Number(h?.id);
  for (const b of bots)
    await db()`UPDATE bots SET owner_id = ${id} WHERE handle = ${b.handle}`;
  return id;
}

const num = (ref: string) => Number(ref.replace("private:", ""));
const peek = async (humanId: number, g: string) =>
  (await readGroupForPerson(db(), humanId, num(g)))?.jobs;

const make = async (who: Bot): Promise<string> => {
  const r = await call(makeRoute, { key: who.key, body: { private: true } });
  expect(r.status).toBe(201);
  return r.body.channel as string;
};
const bringIn = async (l: Bot, g: string, who: Bot) => {
  const inv = await call(invitesRoute, {
    key: l.key,
    params: { id: String(num(g)) },
    body: { for: who.handle },
  });
  expect(inv.status).toBe(201);
  const j = await call(redeemRoute, {
    key: who.key,
    body: { code: inv.body.invite.code },
  });
  expect(j.status).toBe(200);
};
const job = (title: string) => ({
  title,
  body: "Three sections, a line each.",
  check: "Three sections, each with a line.",
});
const post = async (who: Bot, g: string, title: string) => {
  const r = await call(postRoute, {
    key: who.key,
    params: { id: String(num(g)) },
    body: job(title),
  });
  expect(r.status).toBe(201);
  return r.body.job.number as number;
};
const move = async (
  who: Bot,
  g: string,
  number: number,
  body: Record<string, unknown>,
) => {
  const r = await call(moveRoute, {
    key: who.key,
    params: { id: String(num(g)), number: String(number) },
    body,
  });
  expect(r.status).toBe(200);
  return r.body.job;
};
const pin = (ref: string) => ({ store: "github", ref, revision: "abc123" });

// @lea (linked to P) leads a group and brings in @otto (linked to Q).
async function mixed() {
  const lea = await bot("lea");
  const otto = await bot("otto");
  const p = await person("google-p", lea);
  const q = await person("google-q", otto);
  const g = await make(lea);
  await bringIn(lea, g, otto);
  return { lea, otto, p, q, g };
}

// Lea posts a job, otto claims and hands it in with a note, lea sends it
// back with a note, otto takes it on again and hands it in, and lea
// accepts.
async function worked() {
  const c = await mixed();
  const { lea, otto, g } = c;
  const n = await post(lea, g, "Lea's outline job");
  await move(otto, g, n, { move: "claim", if_seq: 0 });
  await move(otto, g, n, {
    move: "submit",
    if_seq: 1,
    outputs: [pin("repo/outline.md")],
    note: "Otto's first try.",
  });
  await move(lea, g, n, {
    move: "revise",
    if_seq: 2,
    note: "Lea: add a line.",
  });
  await move(otto, g, n, { move: "claim", if_seq: 3 });
  await move(otto, g, n, {
    move: "submit",
    if_seq: 4,
    outputs: [pin("repo/outline2.md")],
    note: "Otto's second try.",
  });
  await move(lea, g, n, { move: "accept", if_seq: 5 });
  return { ...c, n };
}

describe("a person's read of their bots' jobs", () => {
  it("shows the leader's person its post and its moves with its notes, and the title", async () => {
    const { p, g, n } = await worked();
    const jobs = await peek(p, g);
    expect(jobs).toEqual([
      {
        number: n,
        title: "Lea's outline job",
        state: "done",
        more: false,
        moves: [
          { by: "lea", kind: "post", at: expect.any(Date), note: null },
          {
            by: "lea",
            kind: "revise",
            at: expect.any(Date),
            note: "Lea: add a line.",
          },
          { by: "lea", kind: "accept", at: expect.any(Date), note: null },
        ],
      },
    ]);
    const text = JSON.stringify(jobs);
    expect(text).not.toContain("Otto's");
    expect(text).not.toContain("outline.md");
  });

  it("shows another person's bot its own moves and notes, never the poster's title or notes", async () => {
    const { q, g, n } = await worked();
    const jobs = await peek(q, g);
    expect(jobs).toEqual([
      {
        number: n,
        title: null,
        state: "done",
        more: false,
        moves: [
          { by: "otto", kind: "claim", at: expect.any(Date), note: null },
          {
            by: "otto",
            kind: "submit",
            at: expect.any(Date),
            note: "Otto's first try.",
          },
          { by: "otto", kind: "claim", at: expect.any(Date), note: null },
          {
            by: "otto",
            kind: "submit",
            at: expect.any(Date),
            note: "Otto's second try.",
          },
        ],
      },
    ]);
    const text = JSON.stringify(jobs);
    expect(text).not.toContain("Lea");
    expect(text).not.toContain("outline.md");
  });

  it("never shows a release's reason, and lists nothing for a person whose bots never touched the board", async () => {
    const { lea, otto, p, q, g } = await mixed();
    const n = await post(lea, g, "Lea's job");
    await move(otto, g, n, { move: "claim", if_seq: 0 });
    await move(otto, g, n, { move: "release", if_seq: 1, reason: "cant_do" });
    const theirs = await peek(q, g);
    expect(theirs?.[0]?.state).toBe("ready");
    expect(theirs?.[0]?.moves.map((m) => m.kind)).toEqual(["claim", "release"]);
    expect(JSON.stringify(theirs)).not.toContain("cant_do");
    // A third bot of a third person, put in after, touched nothing.
    const ria = await bot("ria");
    const r = await person("google-r", ria);
    await bringIn(lea, g, ria);
    expect(await peek(r, g)).toEqual([]);
    // And lea's person sees the job but none of otto's moves.
    expect((await peek(p, g))?.[0]?.moves.map((m) => m.by)).toEqual(["lea"]);
  });

  it("counts a bot's moves only from its link to the reader", async () => {
    const lea = await bot("lea");
    const otto = await bot("otto");
    const p = await person("google-p", lea);
    const g = await make(lea);
    await bringIn(lea, g, otto);
    const n = await post(lea, g, "Lea's job");
    await move(otto, g, n, { move: "claim", if_seq: 0 });
    await move(otto, g, n, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("a")],
      note: "Unlinked otto's words.",
    });
    // Otto is linked to Q only now: nothing it did before shows Q.
    const q = await person("google-q", otto);
    expect(await peek(q, g)).toEqual([]);
    await move(lea, g, n, { move: "revise", if_seq: 2 });
    await move(otto, g, n, { move: "claim", if_seq: 3 });
    const jobs = await peek(q, g);
    expect(jobs?.[0]?.moves.map((m) => m.kind)).toEqual(["claim"]);
    expect(JSON.stringify(jobs)).not.toContain("Unlinked");
    expect(p).toBeGreaterThan(0);
  });

  it("counts a bot's moves only from when it came back into the group", async () => {
    const { lea, otto, q, g } = await mixed();
    const n = await post(lea, g, "Lea's job");
    await move(otto, g, n, { move: "claim", if_seq: 0 });
    const left = await call(leaveRoute, {
      key: otto.key,
      params: { id: String(num(g)) },
    });
    expect(left.status).toBe(200);
    // Not a member: no page at all.
    expect(await readGroupForPerson(db(), q, num(g))).toBeNull();
    await bringIn(lea, g, otto);
    expect(await peek(q, g)).toEqual([]);
  });

  it("leaves out a job whose poster is frozen, and brings it back on unfreeze", async () => {
    const { lea, q, g, n } = await worked();
    await setFrozen(db(), "lea", true, "test");
    expect(await peek(q, g)).toEqual([]);
    await setFrozen(db(), "lea", false, "test");
    expect((await peek(q, g))?.[0]?.number).toBe(n);
    expect(lea.handle).toBe("lea");
  });

  it("lists the newest jobs first and cuts long histories, saying so", async () => {
    const { lea, otto, q, g } = await mixed();
    const first = await post(lea, g, "First");
    // Claim and release over and over: two moves each.
    let seq = 0;
    for (let i = 0; i < PEEK_JOB_MOVES; i++) {
      await move(otto, g, first, { move: "claim", if_seq: seq });
      await move(otto, g, first, {
        move: "release",
        if_seq: seq + 1,
        reason: "unavailable",
      });
      seq += 2;
    }
    const second = await post(lea, g, "Second");
    await move(otto, g, second, { move: "claim", if_seq: 0 });
    const jobs = await peek(q, g);
    expect(jobs?.map((j) => j.number)).toEqual([second, first]);
    expect(jobs?.[1]?.moves).toHaveLength(PEEK_JOB_MOVES);
    expect(jobs?.[1]?.more).toBe(true);
    expect(jobs?.[0]?.more).toBe(false);
    expect(PEEK_JOBS).toBeGreaterThanOrEqual(2);
  });

  it("leaves out the title of a job its poster posted before its link to the reader", async () => {
    const lea = await bot("lea");
    const otto = await bot("otto");
    const p = await person("google-p", lea);
    const g = await make(lea);
    await bringIn(lea, g, otto);
    const n = await post(lea, g, "Lea's title before the link");
    await move(otto, g, n, { move: "claim", if_seq: 0 });
    await move(otto, g, n, {
      move: "submit",
      if_seq: 1,
      outputs: [pin("a")],
      note: "Handed in.",
    });
    // As if lea's link to P were made only now, after it posted: P sees
    // the accept that follows, and neither the post nor its title.
    await ageLink("lea", 0);
    await move(lea, g, n, { move: "accept", if_seq: 2 });
    const jobs = await peek(p, g);
    expect(jobs).toEqual([
      {
        number: n,
        title: null,
        state: "done",
        more: false,
        moves: [
          { by: "lea", kind: "accept", at: expect.any(Date), note: null },
        ],
      },
    ]);
    expect(JSON.stringify(jobs)).not.toContain("before the link");
  });

  it("drops the reader's own frozen bot's moves while it's frozen", async () => {
    const lea = await bot("lea");
    const lou = await bot("lou");
    const p = await person("google-p", lea, lou);
    const g = await make(lea);
    await bringIn(lea, g, lou);
    const n = await post(lea, g, "Lea's job");
    await move(lou, g, n, { move: "claim", if_seq: 0 });
    const by = async () =>
      (await peek(p, g))?.[0]?.moves.map((m) => `${m.by}:${m.kind}`);
    expect(await by()).toEqual(["lea:post", "lou:claim"]);
    await setFrozen(db(), "lou", true, "test");
    expect(await by()).toEqual(["lea:post"]);
    await setFrozen(db(), "lou", false, "test");
    expect(await by()).toEqual(["lea:post", "lou:claim"]);
  });

  it("lists at most PEEK_JOBS jobs, the newest", async () => {
    const lea = await bot("lea");
    const p = await person("google-p", lea);
    const g = await make(lea);
    const numbers: number[] = [];
    for (let i = 0; i <= PEEK_JOBS; i++)
      numbers.push(await post(lea, g, `Job ${i}`));
    const jobs = await peek(p, g);
    expect(jobs?.map((j) => j.number)).toEqual(numbers.slice(1).reverse());
  });
});
