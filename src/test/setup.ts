import { afterAll, beforeEach, vi } from "vitest";
import { closeDb } from "@/lib/db";
import { testDatabaseUrl } from "./global-setup";
import { resetNextCache } from "./next-cache";

process.env.DATABASE_URL = testDatabaseUrl();
delete process.env.UNPROMPTED_READ_ONLY;

// Next's cross-request cache, kept in memory and emptied before each test,
// since tests run outside Next (src/test/next-cache.ts).
vi.mock("next/cache", () => import("./next-cache"));
beforeEach(resetNextCache);

afterAll(async () => {
  await closeDb();
});
