import { describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/db";
import {
  driftHelp,
  planMigrations,
  previewDatabaseProblem,
} from "@/lib/deploy-db";
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
          expect(plan.message).toMatch(/is production's database/);
      }
    }
  });

  it("refuses production from a preview even when it skips migrations", () => {
    for (const flag of [undefined, "0", "true"]) {
      const plan = planMigrations(
        vercel({
          VERCEL_ENV: "preview",
          MIGRATE_PREVIEWS: flag,
          DATABASE_URL: url(prodPooled),
        }),
      );
      expect(plan.action).toBe("fail");
    }
  });

  it("knows production by any of its computes' hosts", () => {
    for (const host of [
      `${productionEndpoint()}-dlj.c-6.us-east-2.aws.neon.tech`,
      `${productionEndpoint()}-dlj-pooler.c-6.us-east-2.aws.neon.tech`,
    ])
      expect(
        previewDatabaseProblem(
          vercel({ VERCEL_ENV: "preview", DATABASE_URL: url(host) }),
        ),
      ).toMatch(/production's database/);
    // A different endpoint that merely starts the same way isn't production.
    expect(
      previewDatabaseProblem(
        vercel({
          VERCEL_ENV: "preview",
          DATABASE_URL: url(
            `${productionEndpoint()}x.c-6.us-east-2.aws.neon.tech`,
          ),
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses a preview database that isn't on its sign-in server's branch", () => {
    const auth = (ep: string) =>
      `https://${ep}.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth`;
    const env = (dbHost: string, authEp: string) =>
      vercel({
        VERCEL_ENV: "preview",
        MIGRATE_PREVIEWS: "1",
        DATABASE_URL: url(dbHost),
        NEON_AUTH_BASE_URL: auth(authEp),
      });
    expect(
      planMigrations(env(branchHost, "ep-calm-tree-a1b2c3d4")).action,
    ).toBe("run");
    expect(
      planMigrations(
        env(
          "ep-calm-tree-a1b2c3d4-pooler.c-6.us-east-2.aws.neon.tech",
          "ep-calm-tree-a1b2c3d4",
        ),
      ).action,
    ).toBe("run");
    const leftover = planMigrations(
      env(
        "ep-proud-art-b4mjhuwr.c-6.us-east-2.aws.neon.tech",
        "ep-calm-tree-a1b2c3d4",
      ),
    );
    expect(leftover.action).toBe("fail");
    if (leftover.action === "fail")
      expect(leftover.message).toMatch(/different Neon branch/);
  });

  it("leaves production and local runs to their own databases", () => {
    expect(
      previewDatabaseProblem(
        vercel({ VERCEL_ENV: "production", DATABASE_URL: url(prodHost) }),
      ),
    ).toBeUndefined();
    expect(
      previewDatabaseProblem({ DATABASE_URL: url(prodHost) }),
    ).toBeUndefined();
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

  it("keeps a preview's running code off production's database too", async () => {
    const saved = { ...process.env };
    await closeDb();
    try {
      process.env.VERCEL = "1";
      process.env.VERCEL_ENV = "preview";
      process.env.DATABASE_URL = url(prodPooled);
      expect(() => db()).toThrow(/production's database/);
    } finally {
      for (const k of ["VERCEL", "VERCEL_ENV", "DATABASE_URL"])
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      await closeDb();
    }
    // And the test database works again afterwards.
    expect((await db()`SELECT 1 AS one`)[0]?.one).toBe(1);
  });

  it("tells a drifted preview the one step that fixes it", () => {
    const help = driftHelp({ VERCEL_GIT_COMMIT_REF: "feature/x" });
    expect(help).toContain("preview/feature/x");
    expect(help).toMatch(/Reset from parent/);
  });
});
