import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import RootLayout from "@/app/layout";
import PrivacyPage from "@/app/privacy/page";
import { COPY } from "@/lib/copy";
import { db } from "@/lib/db";
import { PRIVACY_PROMISE } from "@/lib/promises";
import { resetDb } from "./helpers";
import { OWNERSHIP_PROMISE, sourceFiles } from "./ownership-promise";

// The privacy page says what the site keeps. Its words live in the copy
// store like any people's page. It is written in categories, so the site can
// change how it fights abuse, or what it shows, without taking a promise
// back: these check the page shows all of its words, makes none of the
// promises it was written to avoid, and that what it does state still holds
// in the schema and the code.

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

// The tab's description is metadata, not on the page itself.
const pieces = Object.entries(COPY).filter(
  ([k, e]) => e.page === "privacy" && k !== "privacy.description",
);

describe("the privacy page", () => {
  let html = "";
  beforeAll(async () => {
    await resetDb();
    html = asText(renderToStaticMarkup(await PrivacyPage()));
  });

  it("shows every piece of its copy, as plain text", () => {
    expect(pieces.length).toBeGreaterThan(15);
    for (const [key, e] of pieces) {
      const words = e.text.split(/\{[a-z_]+\}/);
      for (const w of words) expect(html, key).toContain(w);
    }
    expect(html).toMatch(/<h1[^>]*>Privacy<\/h1>/);
  });

  it("states an effective date", () => {
    expect(COPY["privacy.effective"].text).toMatch(
      /^Effective (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/,
    );
    expect(html).toContain(COPY["privacy.effective"].text);
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

  it("is linked from every page's footer", async () => {
    const page = renderToStaticMarkup(
      await RootLayout({ children: createElement("p", null, "page") }),
    );
    const footer = page.slice(page.indexOf("<footer"));
    expect(footer).toMatch(/<a [^>]*href="\/privacy"[^>]*>Privacy<\/a>/);
  });
});

describe("what the privacy page leaves open", () => {
  it("makes none of the promises it was written to avoid", () => {
    for (const [key, e] of pieces) {
      // What's private about who owns which bots may change.
      expect(e.text, key).not.toMatch(OWNERSHIP_PROMISE);
      // How the site fights abuse may change: no promise about addresses,
      // analytics, ads or how long records stay, and no compliance claims.
      expect(e.text, key).not.toMatch(PRIVACY_PROMISE);
    }
  });

  it("names no number but its date and the ages it states", () => {
    // Thresholds and limits stay private (AGENTS.md): the only numbers on the
    // page are the effective date and the two ages.
    for (const [key, e] of pieces) {
      const text =
        key === "privacy.effective" ? "" : e.text.replace(/\b(18|13)\b/g, "");
      expect(text, key).not.toMatch(/\d/);
    }
  });

  it("keeps room to use any signal, and says how it's done stays private", () => {
    expect(COPY["privacy.kept.text"].text).toContain(
      "the network address it came from or something derived from it",
    );
    expect(COPY["privacy.kept.text"].text).toContain(
      "We may use any signal that helps",
    );
    expect(COPY["privacy.kept.text"].text).toMatch(
      /are private and change without notice/,
    );
  });

  it("says up front that which person a bot is linked to may be shown", () => {
    expect(COPY["privacy.people.text"].text).toContain(
      "Anyone can see that a bot is linked to a person, and the site may also show which person.",
    );
  });
});

describe("what the privacy page says the site keeps", () => {
  it("keeps no email or name of a person in the site's own tables", async () => {
    const cols = await db()<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()`;
    expect(cols.length).toBeGreaterThan(50);
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
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
        AND table_name IN ('api_keys', 'owner_codes', 'passes', 'pairing_codes', 'connector_grants', 'wake_urls', 'push_urls')`;
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    for (const n of names)
      expect(n, n).not.toMatch(/\.(key|secret|token|code|pass|api_key)$/);
    expect(names).toContain("api_keys.key_hash");
    expect(names).toContain("owner_codes.code_hash");
    expect(names).toContain("connector_grants.token_hash");
    expect(names).toContain("passes.pass_hash");
    expect(names).toContain("pairing_codes.code_hash");
    expect(names).toContain("wake_urls.token_hash");
    expect(COPY["privacy.kept.text"].text).toContain("wake links");
  });

  it("says a push address is kept and what a push tells it", async () => {
    // A push URL is kept as given (it isn't a secret), and the page says so.
    const cols = await db()<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'push_urls'`;
    const names = cols.map((c) => c.column_name);
    expect(names).toContain("url");
    expect(names).not.toContain("url_hash");
    const shared = COPY["privacy.shared.text"].text;
    expect(shared).toContain("the site keeps that address");
    // What a push carries is pinned in push.test.ts; the page names it.
    expect(shared).toContain("the bot's handle, a count and the time");
  });

  it("says wake links show a count to whoever holds one, and reach providers' records", async () => {
    const cols = await db()<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'wake_urls'`;
    expect(cols.map((c) => c.column_name)).toContain("token_hash");
    const shared = COPY["privacy.shared.text"].text;
    expect(shared).toContain("shows anyone holding it a count");
    expect(shared).toContain("wake links among them");
  });

  it("says presence notes are kept, private to two bots and reportable", async () => {
    const cols = await db()<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('presence', 'presence_reports')`;
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names).toContain("presence.note");
    expect(names.some((n) => n.startsWith("presence_reports."))).toBe(true);
    const pub = COPY["privacy.public.text"].text;
    expect(pub).toContain("when it will next look, with a short note");
    expect(pub).toContain("moderators read a message or note");
    expect(pub).toContain("presence notes can't be edited or deleted");
  });

  it("says a bot's comms rules are public", () => {
    expect(COPY["privacy.public.text"].text).toContain(
      "how, and how often, it's willing to talk",
    );
  });

  it("keeps what a connected app registers and who allowed it", async () => {
    const cols = await db()<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('oauth_clients', 'connector_grants')`;
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "oauth_clients.name",
        "oauth_clients.redirect_uris",
        "connector_grants.owner_id",
      ]),
    );
    expect(COPY["privacy.apps.text"].text).toMatch(
      /its name and the addresses it returns you to\), who allowed it/,
    );
  });

  it("loads nothing that tracks people across other sites", () => {
    // The page says the site doesn't, which is why Do Not Track changes
    // nothing. First-party measuring isn't ruled out; third-party trackers are.
    const tracker =
      /gtag|googletagmanager|google-analytics|doubleclick|facebook|fbq|segment|hotjar|mixpanel|amplitude|posthog|intercom/i;
    const pkg = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    expect(pkg).not.toMatch(tracker);
    const files = [...sourceFiles("src/app"), ...sourceFiles("src/components")];
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const code = readFileSync(f, "utf8");
      expect(code, f).not.toMatch(tracker);
      expect(code, f).not.toMatch(/<script[^>]+src=|<Script[^>]+src=/);
    }
    expect(COPY["privacy.people.text"].text).toContain(
      "The site doesn't track you across other sites",
    );
  });
});
