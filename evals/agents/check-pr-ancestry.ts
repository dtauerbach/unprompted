import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type UnknownReason =
  | "repository"
  | "shallow"
  | "base"
  | "head"
  | "unrelated"
  | "history";
export type AncestryCheck =
  | { status: "current" | "behind"; behind: number }
  | { status: "unknown"; reason: UnknownReason };

function unknown(reason: UnknownReason): AncestryCheck {
  return { status: "unknown", reason };
}

// Compare exact commits already available in the selected local repository.
// Never fetch missing objects, even from a partial clone's promisor remote.
export function checkPrAncestry(
  repository: string,
  base: string,
  head: string,
): AncestryCheck {
  const env = {
    ...process.env,
    GIT_DIR: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_GRAFT_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  };
  function git(...args: string[]) {
    const result = spawnSync("git", ["--no-replace-objects", ...args], {
      cwd: repository,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return { code: result.status, output: result.stdout?.trim() ?? "" };
  }
  const repo = git(
    "rev-parse",
    "--is-shallow-repository",
    "--show-object-format",
  );
  if (repo.code !== 0) return unknown("repository");
  const [shallow, format] = repo.output.split(/\s+/);
  if (shallow === "true") return unknown("shallow");
  if (shallow !== "false" || (format !== "sha1" && format !== "sha256"))
    return unknown("repository");

  const length = format === "sha1" ? 40 : 64;
  const commit = new RegExp(`^[0-9a-f]{${length}}$`, "i");
  const isCommit = (value: string): boolean => {
    if (!commit.test(value)) return false;
    const type = git("cat-file", "-t", value);
    return type.code === 0 && type.output === "commit";
  };
  if (!isCommit(base)) return unknown("base");
  if (!isCommit(head)) return unknown("head");
  const common = git("merge-base", base, head);
  if (common.code === 1) return unknown("unrelated");
  if (common.code !== 0 || !commit.test(common.output))
    return unknown("history");
  const count = git("rev-list", "--count", base, "--not", head, "--");
  const behind = Number(count.output);
  if (
    count.code !== 0 ||
    !/^\d+$/.test(count.output) ||
    !Number.isSafeInteger(behind)
  )
    return unknown("history");
  return { status: behind === 0 ? "current" : "behind", behind };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , base = "", head = ""] = process.argv;
  const result = checkPrAncestry(process.cwd(), base, head);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode =
    result.status === "current" ? 0 : result.status === "behind" ? 1 : 2;
}
