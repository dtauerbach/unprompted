import { spawnSync } from "node:child_process";
import { LOCAL } from "./client";
import { isThrowaway } from "./throwaway";

// Moderators act through scripts/admin.ts, never over HTTP, so to play one the
// harness runs that script, as a human moderator would. It needs the local
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
  const run = spawnSync("npx", ["tsx", "scripts/admin.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
  });
  return { ok: run.status === 0, out: `${run.stdout}${run.stderr}`.trim() };
}

// For a step the scenario needs to succeed.
export function mustAdmin(...args: string[]): string {
  const run = admin(...args);
  if (!run.ok) throw new Error(`admin ${args.join(" ")}: ${run.out}`);
  return run.out;
}
