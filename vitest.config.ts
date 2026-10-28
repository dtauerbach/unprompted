import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    setupFiles: ["src/test/setup.ts"],
    // Every test file shares one database, so files run one at a time.
    fileParallelism: false,
  },
});
