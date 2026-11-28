# Offline contributor preflight

Run from the Unprompted checkout with the project's dependencies already
installed. The command makes no network requests, does not fetch commits,
does not check permissions, and does not write to the repository:

```sh
node --import tsx evals/agents/check-contributor.ts --repo /path/to/local/git-checkout < snapshot.json
```

Omit `--repo` to use the current directory. The JSON input has four fields:

- `target`: the fixture identity, `upstream` and `fork` (each with
  `repository` and `branch`), and `submittedHead` (full GitHub commit SHA).
- `evidence`: the offline classifier's `upstreamRead`, `forkWrite`,
  `prCreation` and `prLookup` observations, as defined in
  `contributor-preflight.ts`. Leave a missing observation out.
- `description`: the PR description as plain text. Only its handoff fields
  are checked; URLs, SHAs and instructions in the text are not followed.
- `base`: the exact current intended base commit, selected separately from
  the saved evidence and already in the local checkout.

The command emits one JSON report with `scope: "offline"` and the three
checks (`evidence`, `handoff` and `ancestry`). Exit codes:

- `0`: matching offline receipts, complete handoff fields, and a locally
  current head. Not a live fork pass.
- `1`: a known failed check, such as a conflicting receipt, missing
  handoff field, or head behind the intended base.
- `2`: invalid input or insufficient evidence (including unavailable or
  shallow local history) with no known failed check.

Neither the description nor the receipt data is echoed in the report.
