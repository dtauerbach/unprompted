// Runs one story trial: a fresh local site, the story's scripted cast, and
// fresh bots given only their owner's line. The harness plays the owners: it
// answers a question from the story's script, grants scheduled visits up to
// the script's allowance, passes a message between owners when a bot asks,
// and logs every touch. Everything lands in one run directory for the judge.
//   npx tsx --conditions=react-server evals/stories/run.ts <story> <arm> [port]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hostLog, type Profile, runVisit, type VisitResult } from "./agent";
import { allowApp } from "./oauth";
import { SCENARIOS } from "./scenarios";
import { type Site, startSite } from "./site";

export type BotSpec = {
  name: string; // the harness's name for it, and its owner's name
  owner: string;
  profile: Profile;
  model: string;
  line: string; // the owner's one line
  about?: string; // the host app's standing instructions (CLAUDE.md)
  answer?: string; // what the owner says to any question
  visitsAllowed?: number; // scheduled visits the owner's app will grant
  others?: string[]; // owners this owner is with (relays)
  httpAllow?: string[];
  startMin?: number; // when the owner sends the line, from the run's start
};

export type Nudge = {
  atMin: number;
  bot: string;
  prompt: string;
  onlyIfNoVisit?: boolean; // skip if the bot came back on its own
  // ...or, sharper: skip if a visit of the bot ended after this minute (its
  // owner already heard how it went).
  unlessVisitEndedAfterMin?: number;
};

export type Ctx = { site: Site; dir: string; t0: number; arm: string };

export type Setup = {
  bots: BotSpec[];
  nudges?: Nudge[];
  background?: Promise<unknown>;
  collect?: () => Promise<unknown>;
  actorIds?: number[];
};

export type Scenario = {
  id: string;
  title: string;
  minutes: number;
  arms: string[];
  setup: (ctx: Ctx) => Promise<Setup>;
};

type Pending = {
  at: number;
  prompt: string;
  cause: string;
  unlessAfter?: number; // epoch ms: skip if a visit ended after this
};

async function main() {
  const [id, arm = "a", portArg] = process.argv.slice(2);
  const sc = SCENARIOS.find((s) => s.id === id);
  if (!sc || !sc.arms.includes(arm)) {
    console.error(
      `usage: run.ts <${SCENARIOS.map((s) => s.id).join("|")}> <arm> [port]`,
    );
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(
    process.env.STORIES_OUT ?? "/srv/stories/runs",
    `${stamp}-${id}-${arm}`,
  );
  mkdirSync(dir, { recursive: true });
  const port = Number(portArg ?? 3100 + Math.floor(Math.random() * 800));
  const site = await startSite({
    name: `${id}_${arm}_${port}`,
    port,
    outDir: dir,
  });
  const t0 = Date.now();
  const ctx: Ctx = { site, dir, t0, arm };
  const events: object[] = [];
  const note = (e: object) => {
    const line = { min: +((Date.now() - t0) / 60000).toFixed(2), ...e };
    events.push(line);
    console.log(JSON.stringify(line));
  };
  try {
    const setup = await sc.setup(ctx);
    // The story's clock starts once its cast is in place.
    const t1 = Date.now();
    note({ setup: "done" });
    const end = t1 + sc.minutes * 60_000;
    const tokens = new Map<string, string>();
    for (const b of setup.bots)
      if (b.profile === "connector")
        tokens.set(
          b.name,
          await allowApp(site.base, `${b.owner}'s assistant app`),
        );
    const queue = new Map<string, Pending[]>(
      setup.bots.map((b) => [
        b.name,
        [
          {
            at: t1 + (b.startMin ?? 0) * 60_000,
            prompt: b.line,
            cause: "owner line",
          },
        ],
      ]),
    );
    for (const n of setup.nudges ?? [])
      queue.get(n.bot)?.push({
        at: t1 + n.atMin * 60_000,
        prompt: n.prompt,
        cause: n.onlyIfNoVisit ? "owner prod (if needed)" : "owner prod",
        unlessAfter:
          n.unlessVisitEndedAfterMin === undefined
            ? undefined
            : t1 + n.unlessVisitEndedAfterMin * 60_000,
      });
    const results = new Map<string, VisitResult[]>(
      setup.bots.map((b) => [b.name, []]),
    );
    const seen = new Map<string, number>(setup.bots.map((b) => [b.name, 0]));
    const byOwner = new Map(setup.bots.map((b) => [b.owner, b]));
    const endedAt = new Map<string, number[]>(
      setup.bots.map((b) => [b.name, []]),
    );
    // The owners' apps act as soon as a bot asks: a message passed to another
    // owner reaches that owner's assistant now, not when the sender's visit
    // ends, and a granted visit is booked now.
    const scanHost = () => {
      for (const b of setup.bots) {
        const log = hostLog(path.join(dir, b.name));
        for (const e of log.slice(seen.get(b.name) ?? 0)) {
          if (e.kind === "schedule_visit_granted")
            queue.get(b.name)?.push({
              at: new Date(e.at).getTime() + e.in_minutes * 60_000,
              prompt: `Your app started you again, as you asked earlier. Your note to yourself: "${e.note}"`,
              cause: "scheduled",
            });
          if (e.kind === "tell_owner" && e.delivered) {
            const to = byOwner.get(e.pass_to);
            if (to)
              queue.get(to.name)?.push({
                at: new Date(e.at).getTime(),
                prompt: `${b.owner} passed me this from their assistant: "${e.message}"`,
                cause: `relay from ${b.owner}`,
              });
          }
        }
        seen.set(b.name, log.length);
      }
    };
    const ticker = setInterval(scanHost, 3000);

    const loop = async (b: BotSpec) => {
      const bdir = path.join(dir, b.name);
      mkdirSync(bdir, { recursive: true });
      const script = path.join(bdir, "owner.json");
      writeFileSync(
        script,
        JSON.stringify({
          answer: b.answer ?? "I'm busy, use your judgment.",
          visits_allowed: b.visitsAllowed ?? 1,
        }),
      );
      if (b.about) {
        mkdirSync(path.join(bdir, "workspace"), { recursive: true });
        writeFileSync(path.join(bdir, "workspace", "CLAUDE.md"), b.about);
      }
      let n = 0;
      while (true) {
        const q = queue.get(b.name) ?? [];
        q.sort((x, y) => x.at - y.at);
        const next = q[0];
        if (Date.now() >= end || (next && next.at > end)) break;
        if (!next || next.at > Date.now() + 5000) {
          // Idle: a relay or prod may still arrive.
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const reported = (endedAt.get(b.name) ?? []).some(
          (t) => next.unlessAfter !== undefined && t > next.unlessAfter,
        );
        if (
          reported ||
          (next.cause === "owner prod (if needed)" &&
            (results.get(b.name)?.length ?? 0) > 1)
        ) {
          q.shift();
          continue;
        }
        await new Promise((r) =>
          setTimeout(r, Math.max(0, next.at - Date.now())),
        );
        // Visits that came due while waiting run together, as one message.
        const due = q.filter((p) => p.at <= Date.now());
        queue.set(
          b.name,
          q.filter((p) => p.at > Date.now()),
        );
        const prompt = due.map((d) => d.prompt).join("\n\n");
        // The owner writing again (a prod or a relay) lands in the same chat,
        // with its history; a scheduled visit starts fresh, with only the note.
        const fromOwner = due.some((d) => d.cause !== "scheduled");
        const last = results.get(b.name)?.at(-1);
        n++;
        note({
          bot: b.name,
          visit: n,
          causes: due.map((d) => d.cause),
          prompt: prompt.slice(0, 300),
        });
        const r = await runVisit({
          bot: b.name,
          profile: b.profile,
          model: b.model,
          prompt,
          dir: bdir,
          base: site.base,
          token: tokens.get(b.name),
          hostScript: script,
          others: b.others,
          httpAllow: b.httpAllow,
          visit: n,
          resume: n > 1 && fromOwner ? last?.sessionId : undefined,
          // A visit may last to the story's end: an always-on bot that
          // waits through it is the point, not a runaway.
          timeoutMs: Math.max(60_000, end + 5 * 60_000 - Date.now()),
        });
        // A continued chat reports its whole cost so far; keep this visit's.
        if (
          n > 1 &&
          fromOwner &&
          r.costUsd !== undefined &&
          last?.sessionId === r.sessionId
        )
          r.costUsd -= last?.sessionCostUsd ?? 0;
        results.get(b.name)?.push(r);
        endedAt.get(b.name)?.push(Date.now());
        note({
          bot: b.name,
          visit: n,
          done: true,
          turns: r.turns,
          cost: r.costUsd,
          calls: r.toolCalls.length,
          timedOut: r.timedOut,
        });
        scanHost();
      }
    };
    await Promise.all(setup.bots.map(loop));
    clearInterval(ticker);
    await Promise.race([
      setup.background ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    const collected = setup.collect ? await setup.collect() : undefined;
    const actorIds = setup.actorIds ?? [];
    const subjects = await site.sql`
      SELECT id, handle, owner_id IS NOT NULL AS claimed, created_at FROM bots
      WHERE NOT is_house AND NOT (id = ANY(${actorIds})) ORDER BY id`;
    const posts = await site.sql`
      SELECT p.id, p.parent_id, c.slug, b.handle, p.title, p.body, p.created_at
      FROM posts p JOIN channels c ON c.id = p.channel_id JOIN bots b ON b.id = p.bot_id
      WHERE p.created_at >= ${new Date(t0)} ORDER BY p.id`;
    const actions = await site.sql`
      SELECT a.action, b.handle, count(*)::int AS n FROM action_log a LEFT JOIN bots b ON b.id = a.bot_id
      WHERE a.at >= ${new Date(t0)} GROUP BY 1, 2 ORDER BY 2, 1`.catch(
      () => [],
    );
    const out = {
      story: sc.id,
      title: sc.title,
      arm,
      started: new Date(t0).toISOString(),
      minutes: sc.minutes,
      bots: setup.bots.map((b) => ({
        ...b,
        visits: results
          .get(b.name)
          ?.map(({ toolCalls, ...r }) => ({ ...r, calls: toolCalls.length })),
        host: hostLog(path.join(dir, b.name)),
        costUsd: (results.get(b.name) ?? []).reduce(
          (s, r) => s + (r.costUsd ?? 0),
          0,
        ),
      })),
      subjects,
      posts,
      actions,
      collected,
      events,
    };
    writeFileSync(path.join(dir, "results.json"), JSON.stringify(out, null, 1));
    note({ done: true, dir });
  } finally {
    await site.stop();
  }
}

await main();
process.exit(0);
