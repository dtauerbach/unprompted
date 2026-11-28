// C1's offline fixture classifier. No GitHub client, credentials, network,
// shell commands, or permission probes. A positive result is not a live pass.
type Ref = { repository: string; branch: string };
type RefReceipt = Ref & { sha: string };

export type PreflightTarget = {
  identity: string;
  upstream: Ref;
  fork: Ref;
  submittedHead: string;
};

type Failure = "unsupported" | "denied";
type Observation<T> = { state: Failure } | { state: "observed"; receipt: T };

export type ContributorEvidence = {
  upstreamRead?: Observation<RefReceipt>;
  forkWrite?: Observation<
    RefReceipt & { parentRepository: string; identity: string }
  >;
  // Comes from tool discovery, not an attempted create.
  prCreation?: Observation<true>;
  // A PR read, not merely an acknowledgement from the create tool.
  prLookup?: Observation<{
    number: number;
    base: RefReceipt;
    head: RefReceipt;
    headParentRepository: string;
  }>;
};

function check<T, U extends "verified" | "exposed">(
  observed: Observation<T> | undefined,
  matches: (receipt: T) => boolean,
  success: U,
): U | Failure | "unverified" | "mismatch" {
  if (!observed) return "unverified";
  if (observed.state !== "observed") return observed.state;
  return matches(observed.receipt) ? success : "mismatch";
}

const fullSha = /^[0-9a-f]{40}$/;
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameRef = (a: Ref, b: Ref) =>
  sameRepo(a.repository, b.repository) && a.branch === b.branch;

export function contributorPreflight(
  target: PreflightTarget,
  evidence: ContributorEvidence,
) {
  const isFork = (parent: string) =>
    !sameRepo(target.fork.repository, target.upstream.repository) &&
    sameRepo(parent, target.upstream.repository);
  const isSubmittedHead = (sha: string) =>
    fullSha.test(sha) && sha === target.submittedHead;
  return {
    scope: "fixture_only" as const,
    upstreamRead: check(
      evidence.upstreamRead,
      (read) => sameRef(read, target.upstream) && fullSha.test(read.sha),
      "verified",
    ),
    forkWrite: check(
      evidence.forkWrite,
      (write) =>
        sameRef(write, target.fork) &&
        isFork(write.parentRepository) &&
        write.identity === target.identity &&
        isSubmittedHead(write.sha),
      "verified",
    ),
    prCreation: check(
      evidence.prCreation,
      (listed) => listed === true,
      "exposed",
    ),
    forkPr: check(
      evidence.prLookup,
      (pr) =>
        Number.isSafeInteger(pr.number) &&
        pr.number > 0 &&
        sameRef(pr.base, target.upstream) &&
        fullSha.test(pr.base.sha) &&
        sameRef(pr.head, target.fork) &&
        isFork(pr.headParentRepository) &&
        isSubmittedHead(pr.head.sha),
      "verified",
    ),
  };
}
