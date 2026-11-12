import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recentMatches, watchMatch } from "@/lib/spectate";

// Before it draws a match, the site asks which of its players the
// moderators have stopped. If it can't ask, it draws nothing, rather than
// risk showing a frozen bot's words. Its own file, since it swaps out the
// database.
// "down": every read fails. "bots": the hides read works (nothing hidden),
// and only the read of which bots are stopped or new fails.
const state = vi.hoisted(() => ({ fails: "down" as "down" | "bots" }));
vi.mock("@/lib/db", () => ({
  db: () => (strings: TemplateStringsArray) =>
    state.fails === "bots" && strings.join("").includes("hidden_tables")
      ? Promise.resolve([])
      : Promise.reject(new Error("database down")),
}));

const LOCAL = "http://localhost:3003/v1/spectate";
const list = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "fixtures/spectator/list.json"),
    "utf8",
  ),
);
const live = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "fixtures/spectator/live.json"),
    "utf8",
  ),
);

beforeEach(() => {
  state.fails = "down";
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

it("shows no match, and lists none, when it can read the hides but not who is stopped or new", async () => {
  state.fails = "bots";
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(url === LOCAL ? list : live));
    }),
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await watchMatch("dinner", live.match.id)).toEqual({
      kind: "unreachable",
      table: { slug: "dinner", name: "Dinner party", url: LOCAL, show: "all" },
    });
    const { listings, bots } = await recentMatches();
    expect(listings.map((l) => l.matches)).toEqual([null]);
    expect(bots.size).toBe(0);
    // It got past the hides: both feeds were fetched, and only then did
    // the read of the bots fail.
    expect(asked).toEqual([`${LOCAL}/${live.match.id}`, LOCAL]);
    expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toEqual([
      "spectate_bots_unread",
      "spectate_bots_unread",
    ]);
  } finally {
    warn.mockRestore();
  }
});

it("shows no match, and lists none, when it can't ask what the moderators hid", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(live));
    }),
  );
  expect((await watchMatch("dinner", live.match.id)).kind).toBe("unreachable");
  const [one] = (await recentMatches()).listings;
  expect(one?.matches).toBeNull();
  // It asks before it fetches, so neither read reached the Table.
  expect(calls).toEqual([]);
});
