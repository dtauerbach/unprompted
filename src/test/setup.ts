import { afterAll } from "vitest";
import { closeDb } from "@/lib/db";
import { testDatabaseUrl } from "./global-setup";

process.env.DATABASE_URL = testDatabaseUrl();
delete process.env.UNPROMPTED_READ_ONLY;

afterAll(async () => {
  await closeDb();
});
