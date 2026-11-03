import { describe, expect, it } from "vitest";
import { driftHelp, planMigrations } from "@/lib/deploy-db";
import { productionEndpoint } from "@/lib/neon-auth-hosts";

// Which database a build migrates is decided from the environment alone.
// Production migrates production; a preview only its own Neon branch.

const prodHost = `${productionEndpoint()}.c-6.us-east-2.aws.neon.tech`;
const prodPooled = `${productionEndpoint()}-pooler.c-6.us-east-2.aws.neon.tech`;
const branchHost = "ep-calm-tree-a1b2c3d4.c-6.us-east-2.aws.neon.tech";
const url = (host: string) =>
  `postgresql://neondb_owner:pw@${host}/neondb?sslmode=require`;

const vercel = (extra: Record<string, string | undefined>) => ({
  VERCEL: "1",
  IP_HASH_SECRET: "x".repeat(40),
  ...extra,
});

describe("what a build does with migrations", () => {
  it("migrates production on a production build, keeping drift a warning", () => {
    expect(
      planMigrations(
        vercel({ VERCEL_ENV: "production", DATABASE_URL: url(prodPooled) }),
      ),
    ).toEqual({
      action: "run",
      url: url(prodPooled),
      appliedIn: "production",
      refuseDrift: false,
    });
  });

  it("prefers the direct connection when there is one", () => {
    const plan = planMigrations(
      vercel({
        VERCEL_ENV: "production",
        DATABASE_URL: url(prodPooled),
        DATABASE_URL_UNPOOLED: url(prodHost),
      }),
    );
    expect(plan).toMatchObject({ action: "run", url: url(prodHost) });
  });

  it("migrates a preview's own branch, and stops it on drift", () => {
    expect(
      planMigrations(
        vercel({
          VERCEL_ENV: "preview",
          MIGRATE_PREVIEWS: "1",
          DATABASE_URL: url(branchHost),
        }),
      ),
    ).toEqual({
      action: "run",
      url: url(branchHost),
      appliedIn: "preview",
      refuseDrift: true,
    });
  });

  it("skips a preview's migrations until MIGRATE_PREVIEWS=1", () => {
    for (const flag of [undefined, "0", "true", ""]) {
      const plan = planMigrations(
        vercel({
          VERCEL_ENV: "preview",
          MIGRATE_PREVIEWS: flag,
          DATABASE_URL: url(branchHost),
        }),
      );
      expect(plan.action).toBe("skip");
    }
  });

  it("refuses to migrate production from a preview, pooled or direct, any case", () => {
    for (const host of [prodHost, prodPooled, prodHost.toUpperCase()]) {
      for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
        const plan = planMigrations(
          vercel({
            VERCEL_ENV: "preview",
            MIGRATE_PREVIEWS: "1",
            DATABASE_URL: url(branchHost),
            [key]: url(host),
          }),
        );
        expect(plan.action).toBe("fail");
        if (plan.action === "fail")
          expect(plan.message).toMatch(/database is production's/);
      }
    }
  });

  it("treats any non-production Vercel build as a preview", () => {
    for (const kind of ["development", undefined, "staging"]) {
      const plan = planMigrations(
        vercel({
          VERCEL_ENV: kind,
          MIGRATE_PREVIEWS: "1",
          DATABASE_URL: url(prodHost),
        }),
      );
      expect(plan.action).toBe("fail");
    }
  });

  it("fails a preview with no database, naming the branch it should have", () => {
    const plan = planMigrations(
      vercel({
        VERCEL_ENV: "preview",
        MIGRATE_PREVIEWS: "1",
        VERCEL_GIT_COMMIT_REF: "claude/some-branch",
      }),
    );
    expect(plan.action).toBe("fail");
    if (plan.action === "fail") {
      expect(plan.message).toContain("preview/claude/some-branch");
      expect(plan.message).toMatch(/branch limit/);
    }
  });

  it("fails a preview whose address isn't one", () => {
    const plan = planMigrations(
      vercel({
        VERCEL_ENV: "preview",
        MIGRATE_PREVIEWS: "1",
        DATABASE_URL: "not a url",
      }),
    );
    expect(plan.action).toBe("fail");
  });

  it("fails a Vercel build without IP_HASH_SECRET before anything else", () => {
    const plan = planMigrations({
      VERCEL: "1",
      VERCEL_ENV: "production",
      DATABASE_URL: url(prodHost),
    });
    expect(plan.action).toBe("fail");
    if (plan.action === "fail") expect(plan.message).toMatch(/IP_HASH_SECRET/);
  });

  it("migrates whatever a local run points at, as local", () => {
    expect(planMigrations({ DATABASE_URL: url(prodHost) })).toEqual({
      action: "run",
      url: url(prodHost),
      appliedIn: "local",
      refuseDrift: false,
    });
    expect(planMigrations({}).action).toBe("fail");
  });

  it("tells a drifted preview the one step that fixes it", () => {
    const help = driftHelp({ VERCEL_GIT_COMMIT_REF: "feature/x" });
    expect(help).toContain("preview/feature/x");
    expect(help).toMatch(/Reset from parent/);
  });
});
