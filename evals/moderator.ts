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
