// Decides, from the environment alone, whether a build applies migrations and
// against which database. scripts/migrate.ts acts on it; it's here so each
// refusal has a test.
//
// Production builds migrate production. Each preview runs on its own Neon
// branch, made from production by Neon's Vercel integration and named
// preview/<git branch>, which hands that deployment its own DATABASE_URL; a
// GitHub Action deletes the branch when its pull request closes
// (scripts/preview-branches.ts). So a preview may migrate, once
// MIGRATE_PREVIEWS=1 says the integration is in place, but never against
// production's endpoint, and it stops if its database ran an older version of
// one of its own migrations (src/lib/migrations.ts).
//
// Later, once real people's data is in production, previews should branch
// from a cleaned or schema-only copy instead of production itself.
import { endpointOf, productionEndpoint } from "./neon-auth-hosts";

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

export function planMigrations(env: Env = process.env): MigrationPlan {
  const onVercel = Boolean(env.VERCEL);
  const kind = env.VERCEL_ENV;
  const preview = onVercel && kind !== "production";

  if (onVercel && !env.IP_HASH_SECRET)
    return {
      action: "fail",
      message:
        "IP_HASH_SECRET is not set. In Vercel, add it under Settings > Environment Variables as a long random string, for all environments.",
    };

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

  if (preview) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return {
        action: "fail",
        message: "This preview's DATABASE_URL is not a full address.",
      };
    }
    if (endpointOf(host) === productionEndpoint())
      return {
        action: "fail",
        message:
          "Refusing to migrate: this preview's database is production's. A preview runs a pull request's code, so it must have its own Neon branch.",
      };
  }

  return {
    action: "run",
    url,
    appliedIn: onVercel ? (kind ?? "unknown") : "local",
    refuseDrift: preview,
  };
}

// What a preview prints when its database already ran an older version of
// its own migrations: the cause, and the one step that fixes it.
export function driftHelp(env: Env = process.env): string {
  const branch = `preview/${env.VERCEL_GIT_COMMIT_REF ?? "<branch>"}`;
  return `Reset this preview's Neon branch, ${branch}, from its parent, then redeploy. In the Neon Console: Branches, ${branch}, Reset from parent. That starts it again from production as it is now, so every migration in this branch runs fresh.`;
}
