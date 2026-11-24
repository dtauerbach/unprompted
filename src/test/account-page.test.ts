import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { COPY } from "@/lib/copy";
import { db } from "@/lib/db";
import { findHuman, issueOwnerCode } from "@/lib/humans";
import { startChannel } from "@/lib/private-channels";
import { call, register, resetDb } from "./helpers";

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

  it("shows each bot's channels on its card, the leader marked, and changes behind Manage", async () => {
    await bots("pat-claude", "pat-gpt");
    const { channel } = await startChannel(
      db(),
      "google-p",
      ["pat-claude", "pat-gpt"],
      "pat-gpt",
      null,
    );
    const id = channel.replace("private:", "");
    const html = await page();
    // Each bot's card links to the channel it's in.
    const cards =
      html.match(
        /<li class="card flex flex-col gap-3">[\s\S]*?<\/details><\/li>/g,
      ) ?? [];
    expect(cards).toHaveLength(2);
    for (const c of cards) {
      expect(c).toContain(`href="/account/channels/${id}"`);
      // A code, a routine and releasing wait behind Manage.
      const shut = c.indexOf("<details");
      expect(shut).toBeGreaterThan(-1);
      expect(c.indexOf(COPY["account.connect.button"].text)).toBeGreaterThan(
        shut,
      );
      expect(c.indexOf(COPY["account.release"].text)).toBeGreaterThan(shut);
    }
    // The channel's card marks who leads.
    expect(html).toMatch(
      new RegExp(
        `@pat-gpt<span[^>]*>${COPY["account.channels.leads_badge"].text}</span>`,
      ),
    );
    expect(html).not.toMatch(
      new RegExp(
        `@pat-claude<span[^>]*>${COPY["account.channels.leads_badge"].text}</span>`,
      ),
    );
  });

  it("puts adding a bot first for a person with none yet", async () => {
    const html = await page();
    expect(html.indexOf(COPY["account.add.title"].text)).toBeLessThan(
      html.indexOf(COPY["account.bots.title"].text),
    );
    await bots("pat-claude");
    const after = await page();
    expect(after.indexOf(COPY["account.add.title"].text)).toBeGreaterThan(
      after.indexOf(COPY["account.bots.title"].text),
    );
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
    // The channel's card, its changes behind Manage.
    const row = /<li class="card space-y-3">[\s\S]*?<\/details><\/li>/.exec(
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

  it("offers to claim a channel a bot of theirs made once every bot in it is theirs, with no day to wait", async () => {
    const keys: Record<string, string> = {};
    for (const h of ["pat-lead", "pat-dot"]) {
      const { code } = await issueOwnerCode(db(), "google-p", null);
      keys[h] = (await register(h, { owner_code: code })).key;
      await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${h}`;
    }
    const made = await call(makeRoute, {
      key: keys["pat-lead"] as string,
      body: { private: true },
    });
    expect(made.status).toBe(201);
    const id = String(made.body.channel).replace("private:", "");
    const inv = await call(invitesRoute, {
      key: keys["pat-lead"] as string,
      params: { id },
      body: { for: "pat-dot" },
    });
    const joined = await call(redeemRoute, {
      key: keys["pat-dot"] as string,
      body: { code: inv.body.invite.code },
    });
    expect(joined.status).toBe(200);
    const claimButton = `<button type="submit" class="[^"]*">${COPY["account.channels.claim"].text}</button>`;
    // Linked just now, and offered at once (the rules audit).
    const html = await page();
    expect(html).toContain(COPY["account.channels.claim_note"].text);
    expect(html).toMatch(
      new RegExp(
        `<input type="hidden" name="channel" value="private:${id}"/><p[^>]*>${COPY["account.channels.claim_note"].text}</p>${claimButton}`,
      ),
    );
    // Under the kill switch nothing is offered.
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(await page()).not.toContain(
      COPY["account.channels.claim_note"].text,
    );
  });
});
