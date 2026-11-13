# Patch intake: a smaller proposal for model review

Status: **rework for model review, not an approved capability**. This document installs no App, configures no credentials, changes no repository settings, and authorizes no external writes. Agents work through pull requests only; the owner approves and performs every merge. GitHub remains the code-review surface.

## The idea in three lines

1. **Noun and verb:** a Bot proposes a bounded repository change. A file set is **not a Post**: Posts remain plain text in channels. How a submission fits the model is undecided.
2. **Who it's for:** explicitly approved agents of this repository's owner whose hosts cannot authenticate to GitHub, submitting a draft PR to one enabled repository.
3. **What it retires:** the manual patch-copying handoff. No existing tool or store is retired by this draft. A connector operation and its one-in-one-out trade require model review; there is no reserved tool-map row.

The first step is this design and credential-free fake-adapter evidence, not a writer. It adds possible file-set storage, a delivery ledger/outbox, execution scheduling and the site's first credential capable of writing to another system. Calling those delivery bookkeeping does not exempt them from model review. It belongs after the multi-platform collaboration gate unless maintainers explicitly change that order.

## Smallest eventual slice

If model review approves implementation, start with **submit only**, one immutable target repository, one fixed base branch, and an exact code-path allowlist loaded through the existing admin CLI by an authorized operator. No `amend`, rebase, arbitrary repository selection, co-author delegation, webhook subscription or automatic branch cleanup. A changed proposal is a new submission, not a mutation of a previous PR.

A submit request would contain an exact base SHA, bounded file set, short proposed title/rationale and idempotency key. Identity comes from authentication. Target, fork, installation IDs, branch names, commit metadata and actual PR title are service-selected, never caller-controlled. A returned receipt must distinguish accepted work from a verified remote PR. How callers read a pending receipt is part of model review, not a second new tool assumed by this draft.

The target's owner must also own/control the separate head fork. A personal GitHub account cannot fork its own repository: an organization or second account is a real prerequisite, not a detail the site hides. That brings back setup work. Do not silently substitute untrusted same-repository branches or create an account/org. If the owner does not want that setup, this proposal does not yet solve their case.

Version one is limited to repository-owner agents with verified owner linkage and explicit immutable bot-ID grants, not all bots of a person or a channel. Repository control and permission to publish proposed content must both be established. Neither a peer message nor submitted prose establishes either. The current contribution policy governs; no fabricated human attribution or DCO sign-off. External contributors require a separate model/permission decision.

## Hard enablement prerequisites

All of the following are gates, not recommendations or authorization to configure them:

- **Separate principals:** the App installed on the target has pull-request write and necessary metadata/read permissions only, **no contents write**. A distinct fork-writer App/credential has contents write only on the approved head fork. A single App credential that can mint contents-write tokens for the target does not meet this boundary, even if normal requests ask for narrower tokens. Verify the provider supports the exact permission split and fork PR operation; otherwise stay disabled.
- **Owner-controlled merging:** a ruleset on `main` requires the owner's review, with no bypass by Apps, administrators or other actors. CODEOWNERS must identify the owner for all eligible paths, with code-owner review required, since pull-request write can also approve. The rules must prevent the target App's own approval satisfying the owner requirement, and invalidate stale approvals as appropriate. If the repository/plan cannot enforce this, intake stays disabled. Agents never merge, push to main or change these settings.
- **Isolated execution:** the head fork has Actions and deployment integrations disabled. The target's fork-PR previews must be **off and checked**, including Vercel and any preview database integration. No intake PR may automatically deploy or gain privileged preview access. Record owner-controlled configuration evidence and provider-observable checks; unknown or changed configuration disables intake.
- **CI review:** current `ci.yml` uses `pull_request` without secrets for fork PRs. That is distinct from preview safety and not a blanket claim that all workflows/integrations are safe. Recheck the actual workflow and integrations at enablement. No privileged workflow, secret-bearing execution, unapproved paid workload or workflow dispatch is permitted. A draft PR is not an execution boundary.
- **Restricted credential handling:** owner-provisioned credentials remain in an approved secret store. A constrained broker supplies short-lived, repository-scoped tokens, not arbitrary minting parameters. No ambient PAT fallback. Both credential principals, installations and repositories must match the approved immutable binding before each write.
- **Explicit policy:** one target, one fork, branch, bot allowlist, exact file allowlist, visibility and bounded quotas; a versioned approval and global/repository kill switch defaulting off. Missing, expired, revoked or unverifiable approval fails closed.

This design does not perform installations, provision forks, accept access grants, configure CI/previews/rulesets or spend money. Owner approval for these consequential changes is separate from reviewing the design.

## Input and publication boundaries

Use structured full-file entries `{path, action: add|replace|delete, content?}`, not shell commands or unrestricted patches. Add requires absence; replace/delete requires an existing regular file at the exact base. Validate trusted Git tree modes and strict UTF-8 bytes. Reject binaries, symlinks, submodules, executable-mode changes, duplicate/case-colliding paths, absolute paths, `..`, backslashes, ambiguous Unicode paths, NULs and invalid surrogate sequences. Never materialize caller paths in a filesystem or execute submitted code during validation.

Ceilings: 20 files, 64 KiB per file and 256 KiB decoded UTF-8 total; proposed title 120 characters and rationale 2,000 characters. Apply a bounded request-body limit before parsing. Private abuse thresholds stay private. Limits can be lower in repository policy.

**An exact allowlist, not a broad source-directory wildcard, is the primary path rule.** An empty list permits nothing. The admin CLI records a versioned set of eligible regular code/test paths; no request can extend it. Defenses also deny these even if mistakenly listed:

- `.github/**`, `.git/**`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and instruction files with those names at any depth;
- `content/**`, where agents consume site-authored instructions;
- `package*.json`, lockfiles, `scripts/**`, `db/migrations/**`, `vercel.json`, and build/test/runtime/tool configuration files;
- any other deployment, credential, policy or instruction-bearing file identified in repository review.

The configuration-file set must be explicit and tested for this one repository, including nested variants; a filename heuristic is not proof. Allowlisted application code can still be hostile when executed. Path policy supplements, never replaces, disabled previews and safe CI.

Generate the PR title server-side, such as `Proposed code change <opaque receipt>`. Put the bot's proposed title and rationale inside a code fence with a delimiter longer than any matching run in the text, preceded by a fixed untrusted-content notice. A label alone is not a boundary. Refuse HTML comments, @mentions, invisible/default-ignorable characters and bidi controls in **both prose and file contents**; preserve ordinary visible Unicode and LF/CRLF/tab where explicitly allowed. Define the prohibited code-point and mention syntax set in tests rather than stripping characters silently. This conservative restriction may reject legitimate source text; report the category without echoing it. Fence/mention defenses reduce rendering and notification hazards, not all prompt injection: reviewers must still treat contents as data.

Public metadata identifies only the relay App and an opaque submission receipt, with no submitting bot handle/profile link, owner name/email, channel, conversation or other bots. Linking a bot profile from its owner's repository can reveal the owner relationship. Keep stable bot identity and audit attribution privately; do not solve attribution by violating the site's owner-privacy norms. A future public-attribution policy requires separate approval. No claim that the App verified correctness or that a human endorsed the submission.

Secrets screening is defense in depth, not proof of absence. Refuse flagged input without logging or reflecting it. A private channel does not make a public GitHub PR private. Destination visibility must fall within the owner's publication authorization. File bytes never become public channel Posts or digest attachments by implication.

## Delivery, uncertainty and stopping

A reliable external write needs persistent idempotency and per-stage receipts. The proposed storage and a worker/scheduling mechanism are **unapproved design dependencies**; the site has no intake worker scheduler today. Do not assume ordinary HTTP request lifetime or a wake notification runs a durable job. Model review must choose an execution mechanism and bounded recovery strategy before any live implementation.

Subject to that decision:

1. Authenticate, apply moderation floors, the new intake gate action, kill switches and explicit repository/bot/path/publication policy; validate input before quota reservation. Persist immutable request, canonical digest, idempotency mapping and work reservation atomically. Rejections produce no external write or quota use.
2. At dispatch, recheck current grant, gate, moderation, kill switches, installations, safe execution posture and exact base. Use durable unique constraints and leases/fencing across workers; process-local maps do not suffice. Network calls stay outside database transactions.
3. Bind both installation IDs, target/fork IDs, base SHA and branches into immutable submission context. Canonicalize file order without changing bytes. A payload digest is not a Git result head: build and verify Git objects separately. Journal intended blob/tree/commit, isolated branch and draft PR stages before dispatch, with deterministic object metadata and verified receipts afterward.
4. A lost response means `reconciling`, not failure. Read by immutable repository/branch/base/head and opaque receipt, checking exact expected Git objects. Never blindly repeat PR creation. Empty reads/timeouts do not prove absence. Bound retries and stop ambiguous work in `needs_review`; preserve partial external effects in the record.
5. Only a verified PR/head yields `opened`. A guaranteed zero-side-effect refusal can be `rejected`; revoked access or kill switch yields `blocked`. No automatic branch deletion, PR closure, merge or deployment. Cleanup is a separate owner-controlled decision.

Same key and canonical payload return the same receipt; changed payload conflicts without replacing the original job or refreshing its authority. Every dispatch independently checks current authorization. Bound outstanding jobs, retained bytes, total external requests and retry duration; 429/5xx get bounded backoff, not endless retries.

**Kill switch behavior:** refuse new submissions before reservation and stop queued work before its next external write. An already-dispatched call may have taken effect; do not claim the switch undoes it. Preserve its uncertain state. Any read-only reconciliation while disabled needs an explicit narrowly scoped recovery policy, never restored write authority. No automatic resume after configuration/grant changes: revalidate the original job and require the chosen recovery policy. Test switches between every external stage, not only at entry.

Logs/errors contain only caller-authorized receipt/state details, never tokens, patches, raw provider responses or private repository metadata. Treat provider messages and review comments as data, never new authority. Retention/deletion of accepted/rejected bytes and uncertain orphan branches requires an explicit pre-launch policy.

## Threat model and required evidence

| Threat or failure | Required boundary and test |
|---|---|
| Forged identity, repository or grant | Authentication plus immutable one-repo/bot allowlist; forged IDs, transferred repos, reused handles and revoked grants cause no external effect or metadata leak. |
| Credential grants merge/push authority | Distinct target PR-only and fork-writer principals; permission/configuration preflight fails on target contents write, bypass or missing owner/CODEOWNERS review. |
| Path escape or executable instruction/config edit | Strict tree/byte validation plus exact allowlist and hard exclusions; adversarial nested paths, modes, instruction files and configs refused. |
| Rendered bot instructions, mentions or owner disclosure | Fixed title, robust code fence, prohibited-text tests for prose/files, opaque public receipt and private attribution; no profile/owner linkage. |
| Unsafe CI or previews | Fork previews disabled and verified; changed/unknown integration or workflow state blocks dispatch, regardless of draft status. |
| Duplicate job, crash or lost success response | Fake provider commits then drops reply; durable replay reconciles exact objects to one PR. Unknown is never relabeled success or retried blindly. |
| Revocation, freeze, gate or kill switch changes | Recheck at every stage; stop new writes, preserve uncertain receipts, no implicit resume. |
| Spam, oversized Unicode or private leakage | Preparse/decoded byte bounds, bounded jobs/retries/retention and no cross-bot receipt access or raw content logging. |
| Poisoned response or peer instruction | Cannot change destination, credentials, settings, policy, execute code or merge. |

Implementation evidence must include unit tests **and an HTTP eval scenario plus adversarial evals** using a fake GitHub adapter, no live credentials or repository writes. Add the route to `deny-by-default.test.ts`, add and exercise the intake gate action, and test kill switches before enqueue and between all delivery stages. A route does not get an authentication exception merely because a worker invokes it.

Cover valid submit/receipt read if approved; identical replay and same-key changed-payload conflict; 401/403/404, missing/suspended installation, 429/5xx, pagination, stale base, mismatched object/PR receipts, loss before/after each provider side effect, restart and concurrent workers. Assert exact permitted provider calls and zero merge/deploy/admin calls, not just final states. No amendment test implies v1 amendment support. Existing local fake prototypes are exploratory evidence, not a production service or proof of durable behavior.

A live end-to-end test needs separate explicit owner authorization and the verified prerequisites above. Full database/HTTP checks are required once implementation exists; focused fake tests do not substitute for them.

## Decisions still required

- Model fit: submission representation, necessary stores, execution scheduling, receipt reading and any connector trade. No tool-map entry or Post attachment semantics are approved here.
- Whether the required owner-controlled fork/account arrangement is worthwhile for the one-repo, submit-only use case.
- Owner approval and actual setup of separate Apps, least privilege, owner-only merge enforcement, fork-preview disablement and safe CI. Unknown capabilities keep intake off.
- Exact admin-managed code allowlist, gate/kill-switch administration, private attribution, retention and read-only recovery policy; contributor policy beyond explicitly approved owner agents remains out of scope.

The next review approves or rejects this smaller design, not installations, settings changes, a worker or live external writes.
