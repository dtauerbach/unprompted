// Deletes the Neon branches that previews ran on, once nothing needs them.
//
// Neon's Vercel integration makes a branch named preview/<git branch> from
// production for each branch that gets a preview, and hands that preview its
// own DATABASE_URL (src/lib/deploy-db.ts). It deletes one only after its git
// branch is deleted, and only the next time some preview deploys, and the
// Neon plan caps how many branches the project can have. So a GitHub Action
// (.github/workflows/preview-db-cleanup.yml) runs this:
//
//   close: when a pull request closes, delete preview/<its branch>, unless
//          another open pull request still uses that branch.
//   sweep: nightly, delete every preview/ branch older than a day with no
//          open pull request whose git branch is gone, or which is over a
//          week old (a branch pushed and abandoned without a pull request).
//          A long-lived branch with no pull request (a `staging` branch, say)
//          loses its database weekly too; its next deploy branches again from
//          production.
//
// It only ever deletes a branch whose name starts with preview/ and that Neon
// doesn't mark as the project's primary, default or protected branch, and
// prints what it did. With --dry-run it prints and deletes nothing.
//
// Plain Node and fetch, no dependencies, so the Action runs it with
// `node --experimental-strip-types` and no npm install.
import { pathToFileURL } from "node:url";

export const PREFIX = "preview/";
const NEON_API = "https://console.neon.tech/api/v2";
const GITHUB_API = "https://api.github.com";
// Warn when the project gets near the plan's branch limit.
const CROWDED = 8;

export type NeonBranch = {
  id: string;
  name: string;
  created_at: string;
  primary?: boolean;
  default?: boolean;
  protected?: boolean;
};

type Fetch = typeof fetch;
type Env = Record<string, string | undefined>;

export function isPreviewBranch(b: NeonBranch): boolean {
  return (
    b.name.startsWith(PREFIX) &&
    b.name.length > PREFIX.length &&
    !b.primary &&
    !b.default &&
    !b.protected &&
    /^br-[a-z0-9-]+$/.test(b.id)
  );
}

export function forClosedPullRequest(
  branches: NeonBranch[],
  headRef: string,
  openHeadRefs: Set<string>,
): NeonBranch[] {
  if (!headRef || openHeadRefs.has(headRef)) return [];
  return branches.filter(
    (b) => isPreviewBranch(b) && b.name === PREFIX + headRef,
  );
}

// Candidates for the nightly sweep: day-old previews with no open pull
// request. Whether each one's git branch still exists is checked after.
export function forSweep(
  branches: NeonBranch[],
  openHeadRefs: Set<string>,
  now: Date,
  minAgeHours = 24,
): NeonBranch[] {
  const cutoff = now.getTime() - minAgeHours * 3_600_000;
  return branches.filter((b) => {
    if (!isPreviewBranch(b)) return false;
    if (openHeadRefs.has(b.name.slice(PREFIX.length))) return false;
    const made = Date.parse(b.created_at);
    return Number.isFinite(made) && made < cutoff;
  });
}

// A sweep candidate whose git branch is still there keeps its database, so a
// branch being pushed before its pull request opens keeps a working preview,
// until it's a week old.
export function abandoned(b: NeonBranch, now: Date, maxAgeDays = 7): boolean {
  const made = Date.parse(b.created_at);
  return (
    Number.isFinite(made) && made < now.getTime() - maxAgeDays * 86_400_000
  );
}

async function json(
  res: Response,
  what: string,
): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`${what} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function listBranches(
  projectId: string,
  apiKey: string,
  f: Fetch = fetch,
): Promise<NeonBranch[]> {
  const out: NeonBranch[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", cursor);
    const body = await json(
      await f(
        `${NEON_API}/projects/${encodeURIComponent(projectId)}/branches?${q}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
        },
      ),
      "Listing Neon branches",
    );
    const got = (body.branches ?? []) as NeonBranch[];
    out.push(...got);
    const next = (body.pagination as { next?: string } | undefined)?.next;
    if (!next || got.length === 0 || next === cursor) break;
    cursor = next;
  }
  return out;
}

export async function openHeadRefs(
  repo: string,
  token: string | undefined,
  f: Fetch = fetch,
): Promise<Set<string>> {
  const refs = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const res = await f(
      `${GITHUB_API}/repos/${repo}/pulls?state=open&per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!res.ok)
      throw new Error(`Listing open pull requests answered ${res.status}`);
    const pulls = (await res.json()) as {
      head?: { ref?: string; repo?: { full_name?: string } | null };
    }[];
    for (const p of pulls)
      if (p.head?.ref && p.head.repo?.full_name === repo) refs.add(p.head.ref);
    if (pulls.length < 100) break;
  }
  return refs;
}

// Whether a git branch exists. Anything but a clear 404 counts as yes, so a
// GitHub hiccup never deletes a database.
export async function gitBranchExists(
  repo: string,
  name: string,
  token: string | undefined,
  f: Fetch = fetch,
): Promise<boolean> {
  const path = name.split("/").map(encodeURIComponent).join("/");
  const res = await f(`${GITHUB_API}/repos/${repo}/branches/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  return res.status !== 404;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RunResult = { deleted: string[]; skipped?: string };

export async function run(
  mode: "close" | "sweep",
  env: Env,
  options: {
    f?: Fetch;
    now?: Date;
    dryRun?: boolean;
    log?: (s: string) => void;
    retryDelayMs?: number;
  } = {},
): Promise<RunResult> {
  const f = options.f ?? fetch;
  const log = options.log ?? console.log;
  const apiKey = env.NEON_API_KEY;
  const projectId = env.NEON_PROJECT_ID;
  const repo = env.GITHUB_REPOSITORY;
  if (!apiKey) return { deleted: [], skipped: "NEON_API_KEY is not set" };
  if (!projectId || !/^[a-z0-9-]{1,60}$/.test(projectId))
    throw new Error("NEON_PROJECT_ID is not set or not a Neon project id");
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error("GITHUB_REPOSITORY is not set");

  let headRef = "";
  if (mode === "close") {
    headRef = env.HEAD_REF ?? "";
    // A fork's branch can share a name with one of ours, and its preview, if
    // any, isn't ours to clean up.
    if (env.HEAD_REPO !== repo)
      return {
        deleted: [],
        skipped: "the pull request came from another repository",
      };
    if (!headRef) throw new Error("HEAD_REF is not set");
  }

  const [branches, open] = await Promise.all([
    listBranches(projectId, apiKey, f),
    openHeadRefs(repo, env.GITHUB_TOKEN, f),
  ]);
  const now = options.now ?? new Date();
  let doomed: NeonBranch[];
  if (mode === "close") doomed = forClosedPullRequest(branches, headRef, open);
  else {
    doomed = [];
    for (const b of forSweep(branches, open, now)) {
      const ref = b.name.slice(PREFIX.length);
      if (
        abandoned(b, now) ||
        !(await gitBranchExists(repo, ref, env.GITHUB_TOKEN, f))
      )
        doomed.push(b);
    }
  }
  if (mode === "close" && doomed.length === 0)
    log(
      open.has(headRef)
        ? `Another open pull request still uses ${headRef}; leaving ${PREFIX}${headRef}.`
        : `No Neon branch named ${PREFIX}${headRef}.`,
    );

  const deleted: string[] = [];
  const failed: string[] = [];
  const del = () => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  for (const b of doomed) {
    if (options.dryRun) {
      log(`Would delete ${b.name} (${b.id}).`);
      continue;
    }
    const at = `${NEON_API}/projects/${encodeURIComponent(projectId)}/branches/${b.id}`;
    try {
      let res = await f(at, del());
      // 423: the branch is busy with another operation. Once more, later.
      if (res.status === 423) {
        await sleep(options.retryDelayMs ?? 10_000);
        res = await f(at, del());
      }
      // Already gone (the integration's own cleanup got there first) is fine.
      if (res.status === 404) {
        log(`${b.name} was already gone.`);
        continue;
      }
      if (!res.ok) throw new Error(`answered ${res.status}`);
      deleted.push(b.name);
      log(`Deleted ${b.name} (${b.id}).`);
    } catch (e) {
      // One stuck branch doesn't keep the others: carry on, fail at the end.
      failed.push(b.name);
      log(
        `::warning::Deleting ${b.name} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const left = branches.length - deleted.length;
  if (left >= CROWDED)
    log(
      `::warning::The Neon project has ${left} branches, near the plan's limit. Previews can't get a database once it's full.`,
    );
  if (failed.length)
    throw new Error(
      `Couldn't delete ${failed.join(", ")}; see the warnings above.`,
    );
  return { deleted };
}

const invoked =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const mode = process.argv[2];
  if (mode !== "close" && mode !== "sweep") {
    console.error("Usage: preview-branches.ts close|sweep [--dry-run]");
    process.exit(2);
  }
  run(mode, process.env, { dryRun: process.argv.includes("--dry-run") })
    .then((r) => {
      if (r.skipped) console.log(`::notice::Nothing to do: ${r.skipped}.`);
    })
    .catch((e: unknown) => {
      console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
