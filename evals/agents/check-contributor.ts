import { readSync } from "node:fs";
import { z } from "zod";
import { checkPrAncestry } from "./check-pr-ancestry";
import { checkPrHandoff } from "./check-pr-handoff";
import { contributorPreflight } from "./contributor-preflight";

const field = z.string().min(1).max(256);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const ref = z.strictObject({ repository: field, branch: field });
const refReceipt = ref.extend({ sha });
const observation = <T extends z.ZodType>(receipt: T) =>
  z.union([
    z.strictObject({ state: z.enum(["unsupported", "denied"]) }),
    z.strictObject({ state: z.literal("observed"), receipt }),
  ]);

const inputSchema = z.strictObject({
  target: z.strictObject({
    identity: field,
    upstream: ref,
    fork: ref,
    submittedHead: sha,
  }),
  evidence: z.strictObject({
    upstreamRead: observation(refReceipt).optional(),
    forkWrite: observation(
      refReceipt.extend({ parentRepository: field, identity: field }),
    ).optional(),
    prCreation: observation(z.literal(true)).optional(),
    prLookup: observation(
      z.strictObject({
        number: z.number().int().positive(),
        base: refReceipt,
        head: refReceipt,
        headParentRepository: field,
      }),
    ).optional(),
  }),
  description: z.string().max(256 * 1024),
  // The intended base is a caller-supplied exact local commit, not whatever
  // base was recorded when the offline evidence happened to be collected.
  base: sha,
});

function inputFromStdin(): unknown {
  const max = 1024 * 1024;
  const bytes = Buffer.alloc(max + 1);
  let count = 0;
  while (count < bytes.length) {
    const read = readSync(0, bytes, count, bytes.length - count, null);
    if (read === 0) break;
    count += read;
  }
  if (count > max) throw new Error("invalid input");
  return JSON.parse(bytes.toString("utf8", 0, count));
}

function run(args: string[]) {
  let repo = process.cwd();
  if (args.length === 2 && args[0] === "--repo" && args[1]) repo = args[1];
  else if (args.length !== 0)
    return { code: 2, report: { scope: "offline", error: "invalid_input" } };
  const input = inputSchema.parse(inputFromStdin());
  const evidence = contributorPreflight(input.target, input.evidence);
  const handoff = checkPrHandoff(input.description);
  const ancestry = checkPrAncestry(
    repo,
    input.base,
    input.target.submittedHead,
  );
  const stages = [
    evidence.upstreamRead,
    evidence.forkWrite,
    evidence.prCreation,
    evidence.forkPr,
  ];
  const failed =
    !handoff.ok ||
    ancestry.status === "behind" ||
    stages.some(
      (s) => s === "denied" || s === "unsupported" || s === "mismatch",
    );
  const unknown =
    ancestry.status === "unknown" || stages.some((s) => s === "unverified");
  return {
    code: failed ? 1 : unknown ? 2 : 0,
    report: { scope: "offline", evidence, handoff, ancestry },
  };
}

let result: ReturnType<typeof run>;
try {
  result = run(process.argv.slice(2));
} catch {
  result = { code: 2, report: { scope: "offline", error: "invalid_input" } };
}
process.stdout.write(`${JSON.stringify(result.report)}\n`);
process.exitCode = result.code;
