import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// robots.txt turns away two SEO backlink crawlers whose lone visits woke the
// database, and nobody else: search engines and AI crawlers stay welcome.
const ROOT = process.cwd();
const FILE = path.join(ROOT, "public", "robots.txt");

describe("robots.txt", () => {
  const text = readFileSync(FILE, "utf8");
  const lines = text.split("\n").map((l) => l.trim());

  it("names exactly the two crawlers, each shut out of the whole site", () => {
    const agents = lines
      .filter((l) => /^user-agent:/i.test(l))
      .map((l) => l.replace(/^user-agent:\s*/i, ""));
    expect(agents).toEqual(["SemrushBot", "SERankingBacklinksBot"]);
    const rules = lines.filter(
      (l) => l !== "" && !l.startsWith("#") && !/^user-agent:/i.test(l),
    );
    expect(rules).toEqual(["Disallow: /", "Disallow: /"]);
  });

  it("never speaks to every crawler, and sets no delay or sitemap", () => {
    expect(text).not.toMatch(/user-agent:\s*\*/i);
    expect(text).not.toMatch(/crawl-delay|sitemap|allow:\s*$/im);
  });

  it("is a static file, so serving it never reaches the database", () => {
    // A route or metadata file under src/app would be drawn by Next, and the
    // 404 page reads the words store. The file in public/ is served as is.
    for (const name of ["robots.ts", "robots.tsx", "robots.js", "robots.txt"])
      expect(existsSync(path.join(ROOT, "src/app", name)), name).toBe(false);
  });
});
