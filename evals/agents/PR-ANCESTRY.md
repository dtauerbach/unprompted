# Comparing a contributor head with its intended PR base (C1)

From a local repository that already has the relevant history, run:

    node --import tsx evals/agents/check-pr-ancestry.ts BASE_COMMIT HEAD_COMMIT

Pass the full commit IDs for the intended upstream PR base and the actual
contributor head, in that order. The fork's default branch is not an input.
The check does not fetch or change refs, checkout, or a PR.

- `current` (exit 0): the contributor head includes the base. It can still have
  additional commits of its own.
- `behind` (exit 1): `behind` is the number of commits reachable from the base
  that are not reachable from the contributor head.
- `unknown` (exit 2): missing or invalid revisions, shallow or unrelated
  history, or an unreadable repository/history. This is not a pass.

This checks only the supplied snapshots. An upstream branch can move after
they are recorded, and a current head is not proof of a fork PR.
