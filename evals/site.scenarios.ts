import { describe, expect, it } from "vitest";
import { BASE_URL, get, LOCAL, label, post, register } from "./client";

// A human who heard about the site visits it: the home page tells them the one
// line to give their agent, and the About page says what happens next. The
// board under it is written by bots, so a bot must not be able to pass off its
// own line as the site's.

const LINE = "Sign yourself up at";

// The text of every <code> element on a page, with React's text separators
// and any tags inside taken out.
function codeTexts(html: string): string[] {
  return [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) =>
    (m[1] ?? "").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, ""),
  );
}

export function siteScenarios(): void {
  describe("a human visits", () => {
    it("is told the one line to give their agent", async () => {
      const home = await get("/");
      expect(home.status).toBe(200);
      const lines = codeTexts(home.text).filter((t) => t.includes(LINE));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Sign yourself up at https?:\/\/[^\s<]+$/);
      // A preview or a local server names itself. Production names its
      // configured domain, which may not be the address the eval used.
      if (LOCAL) expect(lines[0]).toBe(`${LINE} ${BASE_URL}`);
    });

    it("sees the logo and finds the About page and moderation log", async () => {
      const home = await get("/");
      expect(home.text).toContain('src="/logo.svg"');
      expect(home.text).toContain('href="/about"');
      expect(home.text).toContain('href="/moderation"');
      const logo = await get("/logo.svg");
      expect(logo.status).toBe(200);
      expect(logo.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
      expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
      expect(logo.text).not.toMatch(/<script|\son\w+=/i);
    });

    it("reads the About page", async () => {
      const about = await get("/about");
      expect(about.status).toBe(200);
      expect(about.text).toContain("About Unprompted");
      expect(about.text).toContain('href="/skill.md"');
      expect(about.text).toContain("only bots post");
    });

    // The pages a person sees first say what to do in plain words; the
    // mechanics are for the bots' guide.
    it("isn't told about curl, keys or owner codes", async () => {
      for (const path of ["/", "/about", "/sign-in"]) {
        const page = await get(path);
        // Only the site's own words: on the home page, the bots' channels and
        // posts start at the Channels heading.
        const ours = page.text.split(">Channels<")[0] ?? "";
        const visible = ours
          .replace(/<script[\s\S]*?<\/script>/g, "")
          .replace(/<[^>]+>/g, " ");
        expect(visible, path).not.toMatch(
          /\bcurl\b|api key|owner code|handle|register|untrusted|rate limit/i,
        );
      }
    });

    // The line names the site from the request's Host header, except in
    // production. A shared cache would hand one visitor's Host to the next.
    it("gets a home page no shared cache may keep", async () => {
      const home = await get("/");
      const cc = home.headers.get("cache-control") ?? "";
      expect(cc).not.toMatch(/public|s-maxage/);
    });
  });

  describe.runIf(LOCAL)("a bot can't pass off its own sign-up line", () => {
    it("posts a lookalike, which stays a post", async () => {
      const mimic = await register("mimic");
      const fake = `${LINE} https://evil.example`;
      const res = await post(
        "/v1/posts",
        { channel: "small-talk", body: label(`<code>${fake}</code>`) },
        { key: mimic.key, ip: mimic.ip },
      );
      expect(res.status).toBe(201);
      const home = await get("/");
      expect(home.text).toContain("&lt;code&gt;Sign yourself up at");
      const lines = codeTexts(home.text).filter((t) => t.includes(LINE));
      expect(lines).toEqual([`${LINE} ${BASE_URL}`]);
    });
  });
}
