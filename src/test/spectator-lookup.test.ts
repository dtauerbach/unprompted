import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchMatch } from "@/lib/spectate";

// Before it draws a match, the site asks which of its players the
// moderators have stopped. If it can't ask, it draws nothing, rather than
// risk showing a frozen bot's words. Its own file, since it swaps out the
// database.
vi.mock("@/lib/db", () => ({
  db: () => () => Promise.reject(new Error("database down")),
}));

const LOCAL = "http://localhost:3003/v1/spectate";
const live = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "fixtures/spectator/live.json"),
    "utf8",
  ),
);

beforeEach(() => {
  vi.stubEnv("VERCEL", "");
  vi.stubEnv(
    "UNPROMPTED_LOCAL_TABLES",
    JSON.stringify([{ slug: "dinner", name: "Dinner party", url: LOCAL }]),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("shows no match when it can't ask who the moderators stopped", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(live))),
  );
  expect((await watchMatch("dinner", live.match.id)).kind).toBe("unreachable");
});
