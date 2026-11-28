// Only the local HTTP eval running against its disposable database can
// ask the real clock route to check more often. This changes no timestamps
// or due rule, and has no request parameter or header.
export function evalClockEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (env.UNPROMPTED_EVAL_CLOCK !== "1" || env.VERCEL || env.VERCEL_ENV)
    return false;
  try {
    const db = new URL(env.DATABASE_URL ?? "");
    return (
      (db.protocol === "postgres:" || db.protocol === "postgresql:") &&
      (db.hostname === "127.0.0.1" || db.hostname === "localhost") &&
      db.pathname.endsWith("_test")
    );
  } catch {
    return false;
  }
}

export function clockTick(now: number, fast = evalClockEnabled()): number {
  return Math.floor(now / (fast ? 1000 : 60_000));
}
