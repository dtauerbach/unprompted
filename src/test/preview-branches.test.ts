import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  forClosedPullRequest,
  forSweep,
  isPreviewBranch,
  type NeonBranch,
  run,
} from "../../scripts/preview-branches";

// The cleanup that deletes a preview's Neon branch once its pull request
// closes. It must never touch production, or any branch the integration
// didn't make for a preview.

const now = new Date("2026-11-03T12:00:00Z");
const daysAgo = (d: number) =>
  new Date(now.getTime() - d * 86_400_000).toISOString();

const production: NeonBranch = {
  id: "br-floral-union-b4mdz5cf",
  name: "production",
  created_at: daysAgo(30),
  primary: true,
  default: true,
};
const shared: NeonBranch = {
  id: "br-curly-term-b4ihsxcy",
  name: "preview",
  created_at: daysAgo(20),
};
const mine: NeonBranch = {
  id: "br-calm-tree-a1b2c3d4",
  name: "preview/claude/thread-1",
  created_at: daysAgo(2),
};
const other: NeonBranch = {
  id: "br-quiet-lake-e5f6a7b8",
  name: "preview/feature/x",
  created_at: daysAgo(3),
};
const fresh: NeonBranch = {
  id: "br-new-leaf-c9d0e1f2",
  name: "preview/just-pushed",
  created_at: new Date(now.getTime() - 3_600_000).toISOString(),
};
const all = [production, shared, mine, other, fresh];

describe("which Neon branches count as a preview's", () => {
  it("only preview/ ones that Neon doesn't mark primary, default or protected", () => {
    expect(all.filter(isPreviewBranch).map((b) => b.name)).toEqual([
      mine.name,
      other.name,
      fresh.name,
    ]);
    expect(isPreviewBranch({ ...mine, default: true })).toBe(false);
    expect(isPreviewBranch({ ...mine, primary: true })).toBe(false);
    expect(isPreviewBranch({ ...mine, protected: true })).toBe(false);
    expect(isPreviewBranch({ ...mine, name: "preview/" })).toBe(false);
    expect(isPreviewBranch({ ...mine, name: "previews/x" })).toBe(false);
    expect(isPreviewBranch({ ...mine, name: "Preview/x" })).toBe(false);
    // An id that isn't one never reaches a delete address.
    expect(isPreviewBranch({ ...mine, id: "br-x/../../production" })).toBe(
      false,
    );
    expect(isPreviewBranch({ ...mine, id: "../br-x" })).toBe(false);
  });
});

describe("a closed pull request", () => {
  it("deletes exactly its own branch's preview", () => {
    expect(forClosedPullRequest(all, "claude/thread-1", new Set())).toEqual([
      mine,
    ]);
  });

  it("leaves it while another open pull request uses the same branch", () => {
    expect(
      forClosedPullRequest(
        all,
        "claude/thread-1",
        new Set(["claude/thread-1"]),
      ),
    ).toEqual([]);
  });

  it("matches the whole name, never a prefix or production", () => {
    expect(forClosedPullRequest(all, "claude/thread", new Set())).toEqual([]);
    expect(forClosedPullRequest(all, "", new Set())).toEqual([]);
    expect(forClosedPullRequest(all, "../production", new Set())).toEqual([]);
    expect(
      forClosedPullRequest(
        [...all, { ...production, name: "preview/main" }],
        "main",
        new Set(),
      ),
    ).toEqual([]);
  });
});

describe("the nightly sweep", () => {
  it("deletes day-old previews with no open pull request", () => {
    expect(forSweep(all, new Set(["feature/x"]), now)).toEqual([mine]);
  });

  it("leaves a branch pushed in the last day, so its pull request can open", () => {
    expect(forSweep(all, new Set(), now).map((b) => b.name)).not.toContain(
      fresh.name,
    );
  });

  it("leaves a branch whose date it can't read", () => {
    expect(forSweep([{ ...mine, created_at: "soon" }], new Set(), now)).toEqual(
      [],
    );
  });
});

type Call = { url: string; method: string };

function fakeApis(
  branches: NeonBranch[],
  pulls: { ref: string; repo: string | null }[],
  opts: {
    deleteStatus?: number | ((id: string, attempt: number) => number);
    liveGitBranches?: string[];
    pageSize?: number;
  } = {},
) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const ok = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    if (url.startsWith("https://console.neon.tech/api/v2/projects/")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer neon-key",
      );
      if (method === "DELETE") {
        const id = url.slice(url.lastIndexOf("/") + 1);
        const n = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, n);
        const st = opts.deleteStatus;
        return ok({}, typeof st === "function" ? st(id, n) : (st ?? 200));
      }
      const size = opts.pageSize ?? branches.length;
      const cursor = Number(new URL(url).searchParams.get("cursor") ?? "0");
      const page = branches.slice(cursor, cursor + size);
      const next =
        cursor + size < branches.length ? String(cursor + size) : undefined;
      return ok({ branches: page, pagination: next ? { next } : {} });
    }
    const gh = "https://api.github.com/repos/dtauerbach/unprompted/";
    if (url.startsWith(`${gh}pulls`))
      return ok(
        pulls.map((p) => ({
          head: { ref: p.ref, repo: p.repo ? { full_name: p.repo } : null },
        })),
      );
    if (url.startsWith(`${gh}branches/`)) {
      const name = url
        .slice(`${gh}branches/`.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      return (opts.liveGitBranches ?? []).includes(name)
        ? ok({ name })
        : ok({ message: "Branch not found" }, 404);
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { f, calls };
}

const env = {
  NEON_API_KEY: "neon-key",
  NEON_PROJECT_ID: "bold-fire-97549624",
  GITHUB_REPOSITORY: "dtauerbach/unprompted",
  GITHUB_TOKEN: "gh-token",
};
const deletes = (calls: Call[]) =>
  calls.filter((c) => c.method === "DELETE").map((c) => c.url);

describe("running the cleanup", () => {
  it("on close, deletes the pull request's preview branch by id", async () => {
    const { f, calls } = fakeApis(all, []);
    const r = await run(
      "close",
      {
        ...env,
        HEAD_REF: "claude/thread-1",
        HEAD_REPO: "dtauerbach/unprompted",
      },
      { f, now, log: () => {} },
    );
    expect(r.deleted).toEqual([mine.name]);
    expect(deletes(calls)).toEqual([
      `https://console.neon.tech/api/v2/projects/bold-fire-97549624/branches/${mine.id}`,
    ]);
  });

  it("on close, does nothing for a fork's pull request", async () => {
    const { f, calls } = fakeApis(all, []);
    const r = await run(
      "close",
      { ...env, HEAD_REF: "claude/thread-1", HEAD_REPO: "someone/unprompted" },
      { f, now, log: () => {} },
    );
    expect(r.deleted).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("counts a fork's open pull request as no reason to keep our branch", async () => {
    const { f } = fakeApis(all, [
      { ref: "claude/thread-1", repo: "someone/unprompted" },
      { ref: "claude/thread-1", repo: null },
    ]);
    const r = await run(
      "close",
      {
        ...env,
        HEAD_REF: "claude/thread-1",
        HEAD_REPO: "dtauerbach/unprompted",
      },
      { f, now, log: () => {} },
    );
    expect(r.deleted).toEqual([mine.name]);
  });

  it("sweeps, sparing open pull requests and fresh pushes", async () => {
    const { f, calls } = fakeApis(all, [
      { ref: "feature/x", repo: "dtauerbach/unprompted" },
    ]);
    const r = await run("sweep", env, { f, now, log: () => {} });
    expect(r.deleted).toEqual([mine.name]);
    expect(deletes(calls)).toHaveLength(1);
    for (const c of calls) expect(c.url).not.toContain(production.id);
  });

  it("deletes nothing on a dry run", async () => {
    const { f, calls } = fakeApis(all, []);
    const lines: string[] = [];
    const r = await run("sweep", env, {
      f,
      now,
      dryRun: true,
      log: (s) => lines.push(s),
    });
    expect(r.deleted).toEqual([]);
    expect(deletes(calls)).toEqual([]);
    expect(lines.join("\n")).toContain(`Would delete ${mine.name}`);
  });

  it("does nothing, and calls nobody, without a key", async () => {
    const { f, calls } = fakeApis(all, []);
    const r = await run("sweep", { ...env, NEON_API_KEY: "" }, { f, now });
    expect(r).toEqual({ deleted: [], skipped: "NEON_API_KEY is not set" });
    expect(calls).toEqual([]);
  });

  it("takes an already-deleted branch in its stride", async () => {
    const { f } = fakeApis(all, [], { deleteStatus: 404 });
    const r = await run("sweep", env, { f, now, log: () => {} });
    expect(r.deleted).toEqual([]);
  });

  it("fails loudly when Neon refuses a delete, after trying the rest", async () => {
    const stale = { ...other, name: "preview/old-thing" };
    const { f, calls } = fakeApis([production, mine, stale], [], {
      deleteStatus: (id) => (id === mine.id ? 403 : 200),
    });
    const lines: string[] = [];
    await expect(
      run("sweep", env, { f, now, log: (l) => lines.push(l) }),
    ).rejects.toThrow(/Couldn't delete preview\/claude\/thread-1/);
    expect(deletes(calls)).toHaveLength(2);
    expect(lines.join("\n")).toMatch(/::warning::.*answered 403/);
    expect(lines.join("\n")).toContain("Deleted preview/old-thing");
  });

  it("tries a busy branch once more", async () => {
    const { f, calls } = fakeApis([production, mine], [], {
      deleteStatus: (_id, n) => (n === 1 ? 423 : 200),
    });
    const r = await run("sweep", env, {
      f,
      now,
      log: () => {},
      retryDelayMs: 0,
    });
    expect(r.deleted).toEqual([mine.name]);
    expect(deletes(calls)).toHaveLength(2);
  });

  it("spares a live git branch's database for a week, then sweeps it", async () => {
    const live = { liveGitBranches: ["claude/thread-1", "feature/x"] };
    const week = { ...other, created_at: daysAgo(8) };
    const { f } = fakeApis([production, mine, week], [], live);
    const r = await run("sweep", env, { f, now, log: () => {} });
    expect(r.deleted).toEqual([other.name]);
  });

  it("reads every page of Neon's branch list", async () => {
    const { f, calls } = fakeApis(all, [], { pageSize: 2 });
    const r = await run("sweep", env, { f, now, log: () => {} });
    expect(r.deleted.sort()).toEqual([other.name, mine.name].sort());
    expect(
      calls.filter(
        (c) => c.method === "GET" && c.url.includes("console.neon.tech"),
      ),
    ).toHaveLength(3);
  });

  it("refuses a project id that isn't one", async () => {
    const { f, calls } = fakeApis(all, []);
    await expect(
      run("sweep", { ...env, NEON_PROJECT_ID: "../x" }, { f, now }),
    ).rejects.toThrow(/NEON_PROJECT_ID/);
    expect(calls).toEqual([]);
  });

  it("warns when the project nears the plan's branch limit", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `br-b-${i}`,
      name: `preview/open-${i}`,
      created_at: daysAgo(2),
    }));
    const { f } = fakeApis(
      [production, ...many],
      many.map((b) => ({
        ref: b.name.slice("preview/".length),
        repo: "dtauerbach/unprompted",
      })),
    );
    const lines: string[] = [];
    await run("sweep", env, { f, now, log: (s) => lines.push(s) });
    expect(lines.join("\n")).toMatch(/::warning::.*9 branches/);
  });
});

describe("the cleanup workflow", () => {
  const yml = readFileSync(
    path.join(process.cwd(), ".github/workflows/preview-db-cleanup.yml"),
    "utf8",
  );

  it("runs main's code with the key, never a pull request's", () => {
    expect(yml).toMatch(/pull_request_target:\s*\n\s*types: \[closed\]/);
    expect(yml).toMatch(
      /uses: actions\/checkout@v4\s*\n\s*with:\s*\n\s*ref: main/,
    );
    expect(yml).not.toMatch(/pull_request\.head\.sha/);
    expect(yml).not.toMatch(/npm (ci|install)/);
    expect(yml).toMatch(/persist-credentials: false/);
  });

  it("skips a fork's pull request and takes the branch name only as data", () => {
    expect(yml).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    // The branch name reaches the script through the environment alone,
    // never spliced into a shell line.
    const runLines = yml.split("\n").filter((l) => l.includes("run:"));
    for (const l of runLines) expect(l).not.toContain("${{");
  });

  it("can only read the repository", () => {
    expect(yml).toMatch(
      /permissions:\s*\n\s*contents: read\s*\n\s*pull-requests: read\s*\n/,
    );
    expect(yml).not.toMatch(/: write/);
  });
});
