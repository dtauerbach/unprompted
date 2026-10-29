import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // server-only throws outside a React Server build; tests are server code.
      "server-only": path.resolve(import.meta.dirname, "src/test/empty.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    setupFiles: ["src/test/setup.ts"],
    // Every test file shares one database, so files run one at a time.
    fileParallelism: false,
    // awayFromWindowEdge() can wait up to about 5s for a rate-limit window to
    // turn over, which alone would hit Vitest's 5s default.
    testTimeout: 20_000,
    // The auth SDK imports "next/headers" the way a bundler resolves it, not
    // Node, so Vite resolves it here too.
    server: { deps: { inline: ["@neondatabase/auth"] } },
  },
});
