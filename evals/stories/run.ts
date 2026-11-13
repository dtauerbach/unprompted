// Runs one story trial: a fresh local site, the story's scripted cast, and
// fresh bots given only their owner's line. The harness plays the owners: it
// answers a question from the story's script, grants scheduled visits up to
// the script's allowance, passes a message between owners when a bot asks,
// and logs every touch. Everything lands in one run directory for the judge.
//   npx tsx --conditions=react-server evals/stories/run.ts <story> <arm> [port]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { api } from "./actors";
import { hostLog, type Profile, runVisit, type VisitResult } from "./agent";
import { startHostInbox } from "./inbox";
import { allowApp } from "./oauth";
import { orCacheMarks, orOverBudget, orSpent, runOrVisit } from "./or-agent";
import { redact } from "./redact";
import { SCENARIOS } from "./scenarios";
import { type Site, startSite } from "./site";
import {
  arrivalRead,
  groupArrivals,
  seenAfterWakeVisit,
  type WakeSample,
  wakeReader,
} from "./wake";

export type BotSpec = {
  name: string; // the harness's name for it, and its owner's name
  owner: string;
  profile: Profile;
  model: string;
  // Who drives the bot: Claude Code (the default), or a plain tool loop on
  // any OpenRouter model (or-agent.ts), with the same tools.
  runtime?: "claude" | "openrouter";
  // The product this bot's app stands in for and how it is woken (the wake
  // recipe), said in results.json and the transcript so each run records it.
  app?: string;
  line: string; // the owner's one line; "" if the owner sends none
  about?: string; // the host app's standing instructions (CLAUDE.md)
  answer?: string; // what the owner says to any question
  visitsAllowed?: number; // scheduled visits the owner's app will grant
  others?: string[]; // owners this owner is with (relays)
  httpAllow?: string[];
  startMin?: number; // when the owner sends the line, from the run's start
  token?: string; // connector: an app the story's setup already allowed
  // The bot's app listens for its wake number, standing in for a push
  // listener: when the number rises, the app starts a fresh chat on the
  // scheduled lane with this prompt. Nobody sets a time for it.
  // from: the number the app last saw, if it was listening before the
  // story's setup ended (so a rise during setup starts a chat); otherwise it
  // reads the number when the story starts.
  wake?: { key: string; prompt: string; from?: number };
};

// Something the person did before the story's clock started (signing in,
// linking a bot), counted with the owner's touches.
export type SetupTouch = { kind: string; bot?: string; detail?: string };

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
  setupTouches?: SetupTouch[];
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
  // What each bot's host asks of its person's app, whole, in memory only:
  // host.jsonl on disk is redacted.
  const inbox = await startHostInbox();
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
    // STORY_MINUTES shortens the clock, for a dry run of the harness only.
    const end = t1 + Number(process.env.STORY_MINUTES || sc.minutes) * 60_000;
    const tokens = new Map<string, string>();
    for (const b of setup.bots)
      if (b.profile === "connector")
        tokens.set(
          b.name,
          b.token ?? (await allowApp(site.base, `${b.owner}'s assistant app`)),
        );
    const queue = new Map<string, Pending[]>(
      setup.bots.map((b) => {
        const q: Pending[] = b.line
          ? [
              {
                at: t1 + (b.startMin ?? 0) * 60_000,
                prompt: b.line,
                cause: "owner line",
              },
            ]
          : [];
        return [b.name, q];
      }),
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
        const log = inbox.entries(b.name);
        for (const e of log.slice(seen.get(b.name) ?? 0)) {
          if (e.kind === "schedule_visit_granted")
            queue.get(b.name)?.push({
              at: new Date(e.at).getTime() + e.in_minutes * 60_000,
              // An HTTP bot is told the address, as on a wake: the trial's
              // site is at a local address no bot could know, where the real
              // one is public.
              prompt: `Your app started you again, as you asked earlier. Your note to yourself: "${e.note}"${b.profile === "http" ? ` (Unprompted is at ${site.base})` : ""}`,
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
      // Two lanes, as in a real app. The owner's messages (the first line, a
      // prod, a relay) go to one chat, in order: a message sent while that
      // chat is still working waits for it, as typing into a busy chat does.
      // A scheduled visit is the app starting a new chat on time, beside
      // whatever else is running, with only the bot's note.
      let n = 0;
      let ownerBusy = false;
      let ownerLast: VisitResult | undefined;
      const running = new Set<Promise<void>>();
      const visit = async (due: Pending[], lane: "owner" | "scheduled") => {
        const prompt = due.map((d) => d.prompt).join("\n\n");
        const prior = lane === "owner" ? ownerLast : undefined;
        n++;
        const k = n;
        note({
          bot: b.name,
          visit: k,
          causes: due.map((d) => d.cause),
          // Cut down after redacting, so no secret straddles the cut.
          prompt: redact(prompt).slice(0, 300),
        });
        const r = await (b.runtime === "openrouter" ? runOrVisit : runVisit)({
          bot: b.name,
          profile: b.profile,
          model: b.model,
          prompt,
          dir: bdir,
          base: site.base,
          token: tokens.get(b.name),
          hostScript: script,
          hostInbox: inbox.urlFor(b.name),
          others: b.others,
          httpAllow: b.httpAllow,
          visit: k,
          resume: prior?.sessionId,
          // A visit may last to the story's end: an always-on bot that
          // waits through it is the point, not a runaway.
          timeoutMs: Math.max(60_000, end + 5 * 60_000 - Date.now()),
        });
        // A continued chat reports its whole cost so far; keep this visit's.
        if (prior && r.costUsd !== undefined && prior.sessionId === r.sessionId)
          r.costUsd -= prior.sessionCostUsd ?? 0;
        if (lane === "owner") ownerLast = r;
        results.get(b.name)?.push(r);
        endedAt.get(b.name)?.push(Date.now());
        note({
          bot: b.name,
          visit: k,
          lane,
          done: true,
          turns: r.turns,
          cost: r.costUsd,
          calls: r.toolCalls.length,
          timedOut: r.timedOut,
        });
        scanHost();
      };
      let wakeBusy = false;
      // What the listener read while a chat it started runs (wake.ts).
      let wakeSamples: WakeSample[] = [];
      // When a chat started on a wake ends, what the bot read in it is seen:
      // the number as it stood before the reads that showed what arrived,
      // not when the chat began. Anything unknown keeps that number.
      const settleWake = async (hostFrom: number, since: number) => {
        try {
          if (b.wake)
            wakeSeen = seenAfterWakeVisit({
              prev: wakeSeen,
              samples: wakeSamples,
              reads: inbox
                .entries(b.name)
                .slice(hostFrom)
                .flatMap((e) => arrivalRead(e) ?? []),
              groups: await groupArrivals(site.sql, b.wake.key, since),
            });
        } catch (e) {
          note({ bot: b.name, wake_settle_error: String(e) });
        }
        wakeSamples = [];
        wakeBusy = false;
        wakeNext = Date.now();
      };
      const launch = (due: Pending[], lane: "owner" | "scheduled") => {
        const woke = due.some((d) => d.cause === "wake");
        const since = wakeSeenAt;
        if (lane === "owner") ownerBusy = true;
        if (woke) {
          wakeBusy = true;
          wakeSamples = [];
          // Sample from the chat's first seconds: a bot often reads its
          // group right away, and a read with no sample before it changes
          // nothing.
          wakeNext = Date.now();
        }
        const hostFrom = inbox.entries(b.name).length;
        const p = visit(due, lane).finally(async () => {
          if (lane === "owner") ownerBusy = false;
          if (woke) await settleWake(hostFrom, since);
          running.delete(p);
        });
        running.add(p);
      };
      // The app's wake listener: about every 30 seconds it reads the bot's
      // wake number, and when it has passed the last one it took as seen it
      // starts a chat. While that chat runs it only keeps reading, every 5
      // seconds, and when the chat ends takes as seen the number from just
      // before the bot's reads of what arrived (wake.ts): a rise the bot read
      // in that chat starts nothing, a rise after its last read of where it
      // landed starts one more.
      const reader = b.wake
        ? await wakeReader(
            site.base,
            b.wake.key,
            (m, p, k) => api(site.base, m, p, k),
            undefined,
            (why) =>
              note({
                bot: b.name,
                wake_listener: "key",
                wake_listener_error: why,
              }),
          )
        : undefined;
      if (reader)
        note({
          bot: b.name,
          wake_listener: reader.via,
          ...(reader.error ? { wake_listener_error: reader.error } : {}),
        });
      const readWake = async () => (reader ? await reader.read() : Number.NaN);
      let wakeSeen = b.wake?.from ?? (await readWake().catch(() => Number.NaN));
      // When the number taken as seen came back (epoch ms).
      let wakeSeenAt = Date.now();
      let wakeNext = Date.now() + 30_000;
      while (true) {
        if (b.wake && Date.now() >= wakeNext) {
          wakeNext = Date.now() + (wakeBusy ? 5_000 : 30_000);
          const w = await readWake().catch(() => Number.NaN);
          // Busy is read after the answer: a chat that ended meanwhile has
          // set what's seen, and this number is weighed against it.
          if (wakeBusy) {
            if (Number.isFinite(w))
              wakeSamples.push({ at: Date.now(), wake: w });
          } else if (
            Number.isFinite(w) &&
            (!Number.isFinite(wakeSeen) || w > wakeSeen)
          ) {
            const rose = Number.isFinite(wakeSeen) && w > wakeSeen;
            wakeSeen = w;
            wakeSeenAt = Date.now();
            if (rose)
              queue.get(b.name)?.push({
                at: Date.now(),
                prompt: b.wake.prompt,
                cause: "wake",
              });
          }
        }
        const q = queue.get(b.name) ?? [];
        q.sort((x, y) => x.at - y.at);
        const now = Date.now();
        // Idle until the story ends: a relay or prod may still arrive.
        if (now >= end) break;
        // A trial on OpenRouter whose budget is spent ends here.
        if (orOverBudget()) break;
        // Drop prods that are no longer needed.
        const keep = q.filter((p) => {
          if (p.at > now) return true;
          const reported = (endedAt.get(b.name) ?? []).some(
            (t) => p.unlessAfter !== undefined && t > p.unlessAfter,
          );
          return !(
            reported ||
            (p.cause === "owner prod (if needed)" &&
              (results.get(b.name)?.length ?? 0) > 1)
          );
        });
        const isSched = (p: Pending) =>
          p.cause === "scheduled" || p.cause === "wake";
        const sched = keep.filter((p) => p.at <= now && isSched(p));
        const owner = ownerBusy
          ? []
          : keep.filter((p) => p.at <= now && !isSched(p));
        queue.set(
          b.name,
          keep.filter((p) => !sched.includes(p) && !owner.includes(p)),
        );
        // Visits that came due together run together, as one message.
        if (sched.length) launch(sched, "scheduled");
        if (owner.length) launch(owner, "owner");
        await new Promise((r) => setTimeout(r, 1000));
      }
      await Promise.all(running);
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
    // Bots that work together may talk off the board too: to one bot, or in
    // a group (no to; its channel instead).
    const messages = await site.sql`
      SELECT m.id, f.handle AS from_handle, t.handle AS to_handle,
        CASE WHEN m.to_bot_id IS NULL THEN 'private:' || m.channel_id END AS channel,
        m.body, m.created_at
      FROM messages m JOIN bots f ON f.id = m.bot_id LEFT JOIN bots t ON t.id = m.to_bot_id
      WHERE m.created_at >= ${new Date(t0)} ORDER BY m.id`.catch(() => []);
    const presence = await site.sql`
      SELECT p.id, f.handle AS from_handle, t.handle AS to_handle, p.state, p.next_check, p.note, p.created_at
      FROM presence p JOIN bots f ON f.id = p.bot_id JOIN bots t ON t.id = p.other_bot_id
      WHERE p.created_at >= ${new Date(t0)} ORDER BY p.id`.catch(() => []);
    const out = {
      story: sc.id,
      title: sc.title,
      arm,
      started: new Date(t0).toISOString(),
      minutes: sc.minutes,
      setup_touches: setup.setupTouches ?? [],
      // Keys and tokens stay out of the results.
      bots: setup.bots.map(({ token: _token, wake, ...b }) => ({
        ...b,
        wake: wake ? { prompt: wake.prompt } : undefined,
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
      messages,
      presence,
      actions,
      collected,
      events,
      openrouter_spent_usd: orSpent(),
      openrouter_cache_marks: orCacheMarks(),
    };
    // Posts, messages and finals are the bots' words, which may hold a code.
    writeFileSync(
      path.join(dir, "results.json"),
      redact(JSON.stringify(out, null, 1)),
    );
    note({ done: true, dir });
  } finally {
    await inbox.close();
    await site.stop();
  }
}

await main();
process.exit(0);
