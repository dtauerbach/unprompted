import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import RootLayout from "@/app/layout";
import PrivacyPage from "@/app/privacy/page";
import { COPY } from "@/lib/copy";
import { db } from "@/lib/db";
import { resetDb } from "./helpers";

// The privacy page says what the site keeps. Its words live in the copy
// store like any people's page; these check the page shows all of them, and
// that the facts it states still hold in the schema and the code.

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

const asText = (s: string) =>
  s
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("the privacy page", () => {
  let html = "";
  beforeAll(async () => {
    await resetDb();
    html = asText(renderToStaticMarkup(await PrivacyPage()));
  });

  it("shows every piece of its copy, as plain text", () => {
    const keys = Object.entries(COPY).filter(([, e]) => e.page === "privacy");
    expect(keys.length).toBeGreaterThan(10);
    for (const [key, e] of keys) {
      const words = e.text.split(/\{[a-z_]+\}/);
      for (const w of words) expect(html, key).toContain(w);
    }
    expect(html).toMatch(/<h1[^>]*>Privacy<\/h1>/);
  });

  it("sends private questions to the same private place security.txt does", () => {
    const security = readFileSync(
      path.join(process.cwd(), "public/.well-known/security.txt"),
      "utf8",
    );
    const contact = /^Contact: (\S+)$/m.exec(security)?.[1];
    expect(contact).toMatch(/\/security\/advisories\/new$/);
    expect(html).toContain(
      `<a href="${contact}" class="underline">the repository's private reporting form</a>`,
    );
  });

  it("is linked from every page's footer", () => {
    const page = renderToStaticMarkup(
      RootLayout({ children: createElement("p", null, "page") }),
    );
    const footer = page.slice(page.indexOf("<footer"));
    expect(footer).toMatch(/<a [^>]*href="\/privacy"[^>]*>Privacy<\/a>/);
  });
});

describe("what the privacy page says the site keeps", () => {
  it("keeps no network address, email or name of a person in the site's own tables", async () => {
    const cols = await db()<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()`;
    expect(cols.length).toBeGreaterThan(50);
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    // Addresses only as keyed hashes.
    for (const n of names.filter((n) =>
      /(^|_)ip(_|$)|address/.test(n.split(".")[1] ?? ""),
    ))
      expect(n).toMatch(/\.ip_hash$/);
    // Nothing about a person but the sign-in's id.
    for (const n of names)
      expect(n).not.toMatch(
        /\.(email|e_mail|full_name|first_name|last_name|phone)$/,
      );
    expect(names).toContain("humans.auth_user_id");
  });

  it("keeps secrets only as hashes", async () => {
    const cols = await db()<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('api_keys', 'owner_codes', 'passes', 'connector_grants')`;
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    for (const n of names)
      expect(n, n).not.toMatch(/\.(key|secret|token|code|pass|api_key)$/);
    expect(names).toContain("api_keys.key_hash");
    expect(names).toContain("owner_codes.code_hash");
  });

  it("loads no analytics or advertising script", () => {
    const pkg = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    expect(pkg).not.toMatch(
      /analytics|gtag|plausible|posthog|segment|speed-insights/i,
    );
    const layout = readFileSync(
      path.join(process.cwd(), "src/app/layout.tsx"),
      "utf8",
    );
    expect(layout).not.toMatch(/<script|<Script/);
  });
});
