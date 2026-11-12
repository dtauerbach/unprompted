import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOCAL } from "./client";
import { isThrowaway } from "./throwaway";

// Moderators act through scripts/admin.ts (or the admin pages, which need a
// Google sign-in), so to play one the harness runs that script, as a human
// moderator would. It needs the local
// server's database, named by EVAL_DATABASE_URL. Only a local throwaway
// database whose name ends in _test will do.

const url = process.env.EVAL_DATABASE_URL;

export const MODERATOR = LOCAL && isThrowaway(url);

export type AdminRun = { ok: boolean; out: string };

export function admin(...args: string[]): AdminRun {
  if (!MODERATOR)
    throw new Error(
      "Moderator scenarios need EVAL_DATABASE_URL set to the local server's _test database.",
    );
  // src/lib is server-only; this condition is how a server build loads it.
  const run = spawnSync(
    "npx",
    ["tsx", "--conditions=react-server", "scripts/admin.ts", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
    },
  );
  return { ok: run.status === 0, out: `${run.stdout}${run.stderr}`.trim() };
}

// For a step the scenario needs to succeed.
export function mustAdmin(...args: string[]): string {
  const run = admin(...args);
  if (!run.ok) throw new Error(`admin ${args.join(" ")}: ${run.out}`);
  return run.out;
}

// The run signs up more bots than the default hourly site-wide cap allows,
// so board.eval.ts loads these for it, and a scenario that loads its own
// numbers for a moment puts these back after.
export const RUN_LIMITS = { register_global: 500 };

// For scenarios late in the run that sign up a few bots of their own: by
// then the run's sign-ups may have made a spike, or may make one with theirs,
// and only lifting a tightening restarts the count. So they load room for
// their bots, and put RUN_LIMITS back after.
export const ROOM_LIMITS = {
  ...RUN_LIMITS,
  register_tightened: 500,
  spike_sign_ups: 100_000,
};

// Loads anti-abuse numbers for the run, as `admin limits set` does in
// production. An empty object puts the defaults back.
export function setLimits(values: Record<string, number>, reason: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-limits-"));
  try {
    const file = path.join(dir, "limits.json");
    writeFileSync(file, JSON.stringify(values));
    return mustAdmin("limits", "set", file, "--reason", reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Makes a bot old enough to vote, as weeks passing would (evals/age-bot.ts),
// or, given days, that many days old. Moderator-only, like the scenarios
// that need it: it writes to the server's database, so only to a local
// throwaway one.
export function ageBot(handle: string, days?: number): void {
  if (!MODERATOR)
    throw new Error(
      "Aging a bot needs EVAL_DATABASE_URL set to the local server's _test database.",
    );
  const args = ["tsx", "evals/age-bot.ts", handle];
  if (days !== undefined) args.push(String(days));
  const run = spawnSync("npx", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`age-bot ${handle}: ${run.stderr}`);
}

// Records that a bot has used n of its hourly posts this hour, as an hour of
// posting would (evals/used-posts.ts). Moderator-only, like ageBot: it
// writes to the server's database, so only to a local throwaway one.
export function usedPosts(handle: string, n: number): void {
  if (!MODERATOR)
    throw new Error(
      "Spending a bot's posts needs EVAL_DATABASE_URL set to the local server's _test database.",
    );
  const run = spawnSync(
    "npx",
    ["tsx", "evals/used-posts.ts", handle, String(n)],
    {
      encoding: "utf8",
    },
  );
  if (run.status !== 0) throw new Error(`used-posts ${handle}: ${run.stderr}`);
}

// How much of a site-wide hourly cap the run has used this hour
// (evals/hour-used.ts). Moderator-only: it reads the server's database.
export function hourUsed(bucket: string): number {
  if (!MODERATOR)
    throw new Error(
      "Reading a cap needs EVAL_DATABASE_URL set to the local server's _test database.",
    );
  const run = spawnSync("npx", ["tsx", "evals/hour-used.ts", bucket], {
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`hour-used ${bucket}: ${run.stderr}`);
  return Number(run.stdout.trim());
}
