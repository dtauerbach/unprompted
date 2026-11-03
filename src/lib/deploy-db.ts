// Decides, from the environment alone, whether a build applies migrations and
// against which database, and whether a preview may use the database it was
// given at all. scripts/migrate.ts and src/lib/db.ts act on it; it's here so
// each refusal has a test.
//
// Production builds migrate production. Each preview runs on its own Neon
// branch, made from production by Neon's Vercel integration and named
// preview/<git branch>, which hands that deployment its own DATABASE_URL and
// NEON_AUTH_BASE_URL, both from that branch; a GitHub Action deletes the
// branch when its pull request closes (scripts/preview-branches.ts). So a
// preview may migrate, once MIGRATE_PREVIEWS=1 says the integration is in
// place, and stops if its database ran an older version of one of its own
// migrations (src/lib/migrations.ts). Whatever the flag says, a preview never
// builds or runs against production's endpoint.
//
// Later, once real people's data is in production, previews should branch
// from a cleaned or schema-only copy instead of production itself.
import { endpointOf, onEndpoint, productionEndpoint } from "./neon-auth-hosts";

type Env = Record<string, string | undefined>;

export type MigrationPlan =
  | { action: "skip"; message: string }
  | { action: "fail"; message: string }
  | {
      action: "run";
      url: string;
      appliedIn: string;
      refuseDrift: boolean;
    };

// Any Vercel build or function that isn't production runs a branch's code.
export function isPreview(env: Env = process.env): boolean {
  return Boolean(env.VERCEL) && env.VERCEL_ENV !== "production";
}

// Why a preview mustn't use the databases its environment names, if it
// mustn't: one is production's, or isn't an address, or (when the integration
// also gave it an auth server) isn't on the same branch as that auth server,
// which means it came from a leftover variable rather than the integration.
export function previewDatabaseProblem(
  env: Env = process.env,
): string | undefined {
  if (!isPreview(env)) return undefined;
  let authEndpoint: string | undefined;
  if (env.NEON_AUTH_BASE_URL) {
    try {
      authEndpoint = endpointOf(new URL(env.NEON_AUTH_BASE_URL).hostname);
    } catch {
      authEndpoint = undefined;
    }
  }
  for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
    const url = env[key];
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return `This preview's ${key} is not a full address.`;
    }
    if (onEndpoint(host, productionEndpoint()))
      return `Refusing: this preview's ${key} is production's database. A preview runs a pull request's code, so it must have its own Neon branch.`;
    if (authEndpoint?.startsWith("ep-") && !onEndpoint(host, authEndpoint))
      return `Refusing: this preview's ${key} is on a different Neon branch from its sign-in server, so it isn't the database Neon's Vercel integration made for it. Remove any DATABASE_URL set by hand for previews.`;
  }
  return undefined;
}

export function planMigrations(env: Env = process.env): MigrationPlan {
  const onVercel = Boolean(env.VERCEL);
  const kind = env.VERCEL_ENV;
  const preview = isPreview(env);

  if (onVercel && !env.IP_HASH_SECRET)
    return {
      action: "fail",
      message:
        "IP_HASH_SECRET is not set. In Vercel, add it under Settings > Environment Variables as a long random string, for all environments.",
    };

  // Before the flag: a preview that skips its migrations still runs against
  // whatever database it was given.
  const problem = previewDatabaseProblem(env);
  if (problem) return { action: "fail", message: problem };

  if (preview && env.MIGRATE_PREVIEWS !== "1")
    return {
      action: "skip",
      message: `Skipping migrations on a ${kind ?? "non-production"} build.`,
    };

  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (!url)
    return {
      action: "fail",
      message: preview
        ? `This preview has no database of its own. Neon's Vercel integration makes one per branch, named preview/${env.VERCEL_GIT_COMMIT_REF ?? "<branch>"}: check that the integration is connected, and that the Neon project isn't at its branch limit.`
        : "DATABASE_URL is not set. On Vercel, connect the Neon project to this Vercel project (Neon's Vercel integration sets it).",
    };

  return {
    action: "run",
    url,
    appliedIn: onVercel ? (kind ?? "unknown") : "local",
    refuseDrift: preview,
  };
}

// What a preview prints when its own branch already ran an older version of
// one of its migrations: the cause, and the one step that fixes it.
export function driftHelp(env: Env = process.env): string {
  const branch = `preview/${env.VERCEL_GIT_COMMIT_REF ?? "<branch>"}`;
  return `Reset this preview's Neon branch, ${branch}, from its parent, then redeploy. In the Neon Console: Branches, ${branch}, Reset from parent. That starts it again from production as it is now, so every migration in this branch runs fresh.`;
}
