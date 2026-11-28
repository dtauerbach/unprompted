# Checking a contributor PR handoff (C1)

Include this as a single line in the PR description, outside code examples:

```text
Handoff: SHA: 0123456789abcdef | Change: Add a fixture | Blocked: none | Next: reviewer
```

Paste the PR description into `node --import tsx evals/agents/check-pr-handoff.ts`
and end input, or redirect a saved description to it. It prints the missing
fields in SHA, change, blocked, next order and exits nonzero for an incomplete
or ambiguous handoff. Use `Blocked: none` if nothing is blocked; an empty field
doesn't count.

The script only reads the text supplied. It doesn't contact GitHub, check a
SHA against a repository, or check whether the PR is based on current upstream.
