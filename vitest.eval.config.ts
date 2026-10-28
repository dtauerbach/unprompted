import { defineConfig } from "vitest/config";

// Evals drive a running server over HTTP (EVAL_URL). See evals/README.md.
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
