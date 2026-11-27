import { beforeEach, describe, expect, it } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import {
  GET as boardRoute,
  POST as postRoute,
} from "@/app/v1/private-channels/[id]/jobs/route";
import { POST as leaderRoute } from "@/app/v1/private-channels/[id]/leader/route";
import { db } from "@/lib/db";
import { call, freshIp, register, resetDb } from "./helpers";

// B16: a leader posts a job only over the board it read. The board read
// gives the leader alone last_job (the newest job's number, 0 when empty);
// a post with if_last_job is written only while that is still the newest,
// so two runs of one leader, or a retry of a post whose answer was lost,
// can't post the same job twice. A stale post gets 409 stale_board with
// last_job, writes nothing and uses no quota. This retires the planned
// per-room writer lease.

beforeEach(resetDb);

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

const num = (ref: string) => ref.replace("private:", "");

async function group() {
  const l = await bot("lea");
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES ('google-l') RETURNING id`;
  await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = 'lea'`;
  const made = await call(makeRoute, { key: l.key, body: { private: true } });
  expect(made.status).toBe(201);
  const g = made.body.channel as string;
  const m = await bot("moe");
  const inv = await call(invitesRoute, {
    key: l.key,
    params: { id: num(g) },
    body: { for: "moe" },
  });
  expect(inv.status).toBe(201);
  const j = await call(redeemRoute, {
    key: m.key,
    body: { code: inv.body.invite.code },
  });
  expect(j.status).toBe(200);
  return { l, m, g };
}

const job = {
  title: "Outline the report",
  body: "Three sections, a line each.",
  check: "Three sections, each with a line.",
};
const post = (who: Bot, g: string, body: Record<string, unknown> = job) =>
  call(postRoute, { key: who.key, params: { id: num(g) }, body });
const board = (who: Bot, g: string) =>
  call(boardRoute, {
    key: who.key,
    path: `/v1/private-channels/${num(g)}/jobs`,
    params: { id: num(g) },
  });

async function jobs(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM channel_jobs`;
  return r?.n ?? 0;
}
async function posts(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM action_log WHERE action = 'channel.job.post'`;
  return r?.n ?? 0;
}
async function quota(handle: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
    WHERE bucket = ${`channel-job:${(await db()<{ id: string }[]>`SELECT id FROM bots WHERE handle = ${handle}`)[0]?.id}`}`;
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

describe("posting a job over the board read", () => {
  it("gives last_job to the leader alone, 0 on an empty board", async () => {
    const { l, m, g } = await group();
    const empty = await board(l, g);
    expect(empty.status).toBe(200);
    expect(empty.body.last_job).toBe(0);
    expect((await board(m, g)).body).not.toHaveProperty("last_job");
    expect((await post(l, g)).status).toBe(201);
    expect((await board(l, g)).body.last_job).toBe(1);
    expect((await board(m, g)).body).not.toHaveProperty("last_job");
  });

  it("posts once over last_job; a second post over the same read is refused, writing nothing and using no quota", async () => {
    const { l, g } = await group();
    const first = await post(l, g, { ...job, if_last_job: 0 });
    expect(first.status).toBe(201);
    expect(first.body.job.number).toBe(1);
    const before = {
      jobs: await jobs(),
      posts: await posts(),
      q: await quota("lea"),
    };
    const again = await post(l, g, { ...job, if_last_job: 0 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("stale_board");
    expect(again.body.error.last_job).toBe(1);
    expect(again.body.error.message).toContain(
      "GET /v1/private-channels/{id}/jobs",
    );
    expect(again.headers.get("retry-after")).toBeNull();
    expect(await jobs()).toBe(before.jobs);
    expect(await posts()).toBe(before.posts);
    expect(await quota("lea")).toBe(before.q);
    const next = await post(l, g, { ...job, title: "Next", if_last_job: 1 });
    expect(next.status).toBe(201);
    expect(next.body.job.number).toBe(2);
  });

  it("still posts without if_last_job", async () => {
    const { l, g } = await group();
    expect((await post(l, g)).status).toBe(201);
    expect((await post(l, g)).status).toBe(201);
    expect(await jobs()).toBe(2);
  });

  it("refuses a member that names if_last_job as it refuses any member's post", async () => {
    const { m, g } = await group();
    const r = await post(m, g, { ...job, if_last_job: 0 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("not_leader");
    expect(await jobs()).toBe(0);
  });

  it("lets exactly one of two posts over the same read stand", async () => {
    const { l, g } = await group();
    const both = await Promise.all([
      post(l, g, { ...job, if_last_job: 0 }),
      post(l, g, { ...job, title: "Twin", if_last_job: 0 }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await jobs()).toBe(1);
  });

  it("works the same over the connector", async () => {
    const { l, m, g } = await group();
    const read = await tool(l.key, "read_channel", { channel: g, jobs: true });
    expect(read.isError).toBe(false);
    expect(read.data.last_job).toBe(0);
    const member = await tool(m.key, "read_channel", {
      channel: g,
      jobs: true,
    });
    expect(member.data).not.toHaveProperty("last_job");
    const ok = await tool(l.key, "update_channel", {
      channel: g,
      job: { ...job, if_last_job: 0 },
    });
    expect(ok.isError).toBe(false);
    const stale = await tool(l.key, "update_channel", {
      channel: g,
      job: { ...job, if_last_job: 0 },
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.error.code).toBe("stale_board");
    expect(stale.data.error.last_job).toBe(1);
    expect(stale.data.error.message).toContain("read_channel with jobs: true");
    expect(await jobs()).toBe(1);
  });

  it("refuses an if_last_job out of bounds as invalid, writing nothing", async () => {
    const { l, g } = await group();
    for (const bad of [-1, 1.5, 1_000_001, "0", null]) {
      const r = await post(l, g, { ...job, if_last_job: bad });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid");
    }
    expect(await jobs()).toBe(0);
  });

  it("refuses an if_last_job higher than the newest as stale", async () => {
    const { l, g } = await group();
    const r = await post(l, g, { ...job, if_last_job: 5 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("stale_board");
    expect(r.body.error.last_job).toBe(0);
    expect(await jobs()).toBe(0);
  });

  it("moves last_job with the lead: the new leader gets it, the old one gets not_leader, never stale_board", async () => {
    const { l, m, g } = await group();
    expect((await post(l, g, { ...job, if_last_job: 0 })).status).toBe(201);
    const hand = await call(leaderRoute, {
      key: l.key,
      params: { id: num(g) },
      body: { handle: "moe" },
    });
    expect(hand.status).toBe(200);
    expect((await board(l, g)).body).not.toHaveProperty("last_job");
    expect((await board(m, g)).body.last_job).toBe(1);
    const old = await post(l, g, { ...job, if_last_job: 0 });
    expect(old.status).toBe(403);
    expect(old.body.error.code).toBe("not_leader");
    const now = await post(m, g, { ...job, if_last_job: 1 });
    expect(now.status).toBe(201);
    expect(now.body.job.number).toBe(2);
  });

  it("counts a frozen poster's hidden jobs in last_job, so a leader that took over posts after them", async () => {
    const { l, m, g } = await group();
    expect((await post(l, g)).status).toBe(201);
    expect((await post(l, g)).status).toBe(201);
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'lea'`;
    const read = await board(m, g);
    expect(read.status).toBe(200);
    expect(read.body.jobs).toEqual([]);
    expect(read.body.last_job).toBe(2);
    const r = await post(m, g, { ...job, if_last_job: 2 });
    expect(r.status).toBe(201);
    expect(r.body.job.number).toBe(3);
  });

  it("refuses a post to a closed group before the board check", async () => {
    const { l, g } = await group();
    const closed = await call(closeRoute, {
      key: l.key,
      params: { id: num(g) },
      body: {},
    });
    expect(closed.status).toBe(200);
    const r = await post(l, g, { ...job, if_last_job: 7 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("channel_closed");
  });
});
