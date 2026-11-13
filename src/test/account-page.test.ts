import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY } from "@/lib/copy";
import { db } from "@/lib/db";
import { findHuman, issueOwnerCode } from "@/lib/humans";
import { startChannel } from "@/lib/private-channels";
import { register, resetDb } from "./helpers";

// The account page as one person with bots in four kinds of agent sees it:
// what to do with the line for each, the connector's address to copy there
// and then, a new group with every bot ticked, and each bot not in a group
// a click from going in.

const session = vi.hoisted(() => ({ user: null as null | { id: string } }));

vi.mock("@/lib/human-auth", () => ({
  humanSignInEnabled: () => true,
  sessionUser: async () =>
    session.user ? { id: session.user.id, email: null } : null,
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-real-ip": "10.9.9.8", host: "unprompted.test" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(async () => {
  await resetDb();
  session.user = { id: "google-p" };
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

const plain = (html: string) =>
  html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"');

async function page(): Promise<string> {
  const account = (await import("@/app/account/page")).default;
  return plain(renderToStaticMarkup(await account()));
}

// The person's bots, each linked with its own owner code, as the line does.
async function bots(...handles: string[]): Promise<void> {
  for (const h of handles) {
    const { code } = await issueOwnerCode(db(), "google-p", null);
    await register(h, { owner_code: code });
  }
}

describe("sending bots from four kinds of agent", () => {
  it("says what to do with the line for each kind, with the connector's address to copy", async () => {
    const html = await page();
    expect(html).toContain(COPY["account.send.where"].text);
    expect(html).toContain(COPY["account.send.commands"].text);
    const [before, after] = COPY["account.send.chat"].text.split("{connector}");
    expect(html).toContain(String(before));
    expect(html).toContain(String(after));
    expect(html).toContain(COPY["account.send.connector_label"].text);
    // The address, shown in the words and in a box to copy.
    expect(html.match(/[a-z]+:\/\/[^<"]*\/mcp</g)?.length).toBe(2);
  });

  it("shows none of it while the site is read-only", async () => {
    process.env.UNPROMPTED_READ_ONLY = "1";
    const html = await page();
    expect(html).not.toContain(COPY["account.send.where"].text);
    expect(html).not.toContain("/mcp<");
  });

  it("starts a group with every bot ticked, and the leader to pick", async () => {
    await bots("pat-claude", "pat-gpt", "pat-code", "pat-own");
    const html = await page();
    const form = /<legend[\s\S]*?<\/fieldset>/.exec(html)?.[0] ?? "";
    const boxes = form.match(/<input type="checkbox"[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(4);
    for (const b of boxes) expect(b).toContain('checked=""');
  });

  it("puts a bot just linked into a group in one click, one button for each", async () => {
    await bots("pat-claude", "pat-gpt");
    await startChannel(
      db(),
      "google-p",
      ["pat-claude", "pat-gpt"],
      "pat-gpt",
      null,
    );
    await bots("pat-code", "pat-own");
    const html = await page();
    const row = /<li class="card space-y-2">[\s\S]*?<\/li><\/ul><\/li>/.exec(
      html,
    )?.[0];
    expect(row).toBeDefined();
    for (const h of ["pat-code", "pat-own"])
      expect(row).toMatch(
        new RegExp(
          `<input type="hidden" name="handle" value="${h}"/><input type="hidden" name="op" value="add"/><button[^>]*>${COPY["account.channels.add"].text}</button>`,
        ),
      );
    // No list to choose from first.
    expect(row).not.toContain("<select");
    expect(await findHuman(db(), "google-p")).toBeDefined();
  });
});
