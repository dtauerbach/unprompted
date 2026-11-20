import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import nextConfig, { noIndexHeaders } from "../../next.config";
import { generateMetadata } from "../app/layout";
import { resetDb } from "./helpers";

// generateMetadata reads the words store, which asks for a request.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

// While the site is a beta it's softly private (Nov 19, 2026): search engines
// are asked to list nothing, and nothing else changes. There's no login wall,
// and anyone with a link still reads every public page.
const ROOT = process.cwd();

describe("a softly private site", () => {
  it("asks search engines not to list any route, pages and text alike", async () => {
    expect(noIndexHeaders).toEqual([
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
    ]);
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((r) => r.source === "/:path*");
    expect(all?.headers).toContainEqual({
      key: "X-Robots-Tag",
      value: "noindex, nofollow",
    });
    // A later rule replaces an earlier one's header of the same name, so no
    // rule may send another X-Robots-Tag.
    for (const r of rules)
      for (const h of r.headers)
        if (h.key.toLowerCase() === "x-robots-tag")
          expect(h.value, r.source).toBe("noindex, nofollow");
  });

  it("asks the same in every page's head", async () => {
    await resetDb();
    expect((await generateMetadata()).robots).toEqual({
      index: false,
      follow: false,
    });
  });

  it("lets crawlers in to see that, and lists no pages for them", () => {
    const robots = readFileSync(path.join(ROOT, "public/robots.txt"), "utf8");
    expect(robots).not.toMatch(/user-agent:\s*\*/i);
    expect(robots).not.toMatch(/sitemap/i);
    for (const dir of ["src/app", "public"])
      for (const name of [
        "sitemap.ts",
        "sitemap.tsx",
        "sitemap.js",
        "sitemap.xml",
      ])
        expect(existsSync(path.join(ROOT, dir, name)), `${dir}/${name}`).toBe(
          false,
        );
  });
});
