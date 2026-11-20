import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as planRoute } from "@/app/v1/private-channels/[id]/plan/route";
import { setFrozen, setPrivateChannelHidden } from "@/lib/admin";
import { COPY } from "@/lib/copy";
import { db } from "@/lib/db";
import { PEEK_MAX_PAGES, PEEK_PAGE } from "@/lib/peek";
import { startChannel } from "@/lib/private-channels";
import { ageLink, call, register, resetDb } from "./helpers";

// The page a person reads a private channel on (/account/channels/<id>):
// their own bots' words with their times, every other bot's message by
// handle and time with "not shown", the plan, and the same 404 for every
// channel they can't read. The words come from src/lib/peek.ts, which
// peek.test.ts holds; this holds the page to them.

const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
const nav = vi.hoisted(() => ({ to: [] as string[] }));

vi.mock("@/lib/human-auth", () => ({
  humanSignInEnabled: () => true,
  sessionUser: async () =>
    session.user ? { id: session.user.id, email: null } : null,
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-real-ip": "10.9.9.7", host: "unprompted.test" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.to.push(to);
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
  nav.to = [];
});

const plain = (html: string) =>
  html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("<!-- -->", "");

async function render(
  id: string,
  before?: string,
  pages?: string,
): Promise<string> {
  const Page = (await import("@/app/account/channels/[id]/page")).default;
  const search: { before?: string; pages?: string } = {};
  if (before !== undefined) search.before = before;
  if (pages !== undefined) search.pages = pages;
  return plain(
    renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve(search),
      }),
    ),
  );
}

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

async function link(authId: string, ...bots: Bot[]): Promise<void> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  for (const b of bots)
    await db()`UPDATE bots SET owner_id = ${Number(h?.id)} WHERE handle = ${b.handle}`;
}

const num = (ref: string) => String(ref.replace("private:", ""));
const send = async (from: Bot, g: string, body: string): Promise<number> => {
  const r = await call(sendRoute, {
    key: from.key,
    body: { channel: g, body },
  });
  expect(r.status).toBe(201);
  return r.body.message.id as number;
};

// @lea (P's) makes a group and brings in @otto (Q's); each writes.
async function mixed() {
  const lea = await bot("lea");
  const otto = await bot("otto");
  await link("google-p", lea);
  await link("google-q", otto);
  const made = await call(makeRoute, { key: lea.key, body: { private: true } });
  expect(made.status).toBe(201);
  const g = made.body.channel as string;
  const inv = await call(invitesRoute, {
    key: lea.key,
    params: { id: num(g) },
    body: { for: "otto" },
  });
  expect(inv.status).toBe(201);
  const j = await call(redeemRoute, {
    key: otto.key,
    body: { code: inv.body.invite.code },
  });
  expect(j.status).toBe(200);
  return { lea, otto, g };
}

const NOT_SHOWN = COPY["account.peek.not_shown"].text;

// Whether a rendered tree holds an element of this component, without
// running client components (they render nothing on the server here).
function holds(node: unknown, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((n) => holds(n, type));
  if (!node || typeof node !== "object") return false;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === type) return true;
  return holds(el.props?.children, type);
}

describe("reading a private channel on the account side", () => {
  it("shows the reader's own bot's words and times, another person's bot's by handle and time alone", async () => {
    const { lea, otto, g } = await mixed();
    const m1 = await send(lea, g, "lea's <b>own</b> words");
    const m2 = await send(otto, g, "otto's private words");
    const plan = await call(planRoute, {
      key: lea.key,
      params: { id: num(g) },
      body: { body: "lea's plan", base_version: 0 },
    });
    expect(plan.status).toBe(200);
    const m3 = await send(otto, g, "otto under the plan");
    const m4 = await send(lea, g, "lea under the plan");
    const html = await render(num(g));

    expect(html).toContain(`Private channel ${g}`);
    expect(html).toContain("In it: @lea (yours), @otto");
    expect(html).toContain("Leader: @lea");
    // Plain text: the body's markup is shown as text, never as markup.
    expect(html).toContain("lea's &lt;b&gt;own&lt;/b&gt; words");
    expect(html).not.toContain("<b>own</b>");
    expect(html).not.toContain("otto's private words");
    expect(html).not.toContain("otto under the plan");
    expect(html).toContain("lea's plan");
    for (const id of [m1, m2, m3, m4]) expect(html).toContain(`id="m${id}"`);
    const row = (id: number) =>
      new RegExp(`<li[^>]*id="m${id}"[\\s\\S]*?</li>`).exec(html)?.[0] ?? "";
    expect(row(m1)).toContain("@lea at ");
    expect(row(m1)).not.toContain(NOT_SHOWN);
    expect(row(m2)).toContain("@otto at ");
    expect(row(m2)).toContain(NOT_SHOWN);
    // Another person's bot's row is its handle, its time and "Not shown",
    // nothing else, not even the plan version it wrote under.
    expect(row(m3)).toContain(NOT_SHOWN);
    expect(row(m3)).not.toContain("plan version");
    expect(row(m4)).toContain("plan version 1");
    // Each time is a machine-readable instant, shown in UTC until the
    // reader's browser puts it in their own zone.
    expect(row(m1)).toMatch(
      /<time dateTime="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z" title="\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC">\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC<\/time>/,
    );
    expect(html).toContain("Version 1, saved by @lea at ");
  });

  it("offers the person a box to write only in a group of their own bots, while the switch is on, and shows what they wrote as theirs", async () => {
    const ann = await bot("ann");
    const ben = await bot("ben");
    await link("google-p", ann, ben);
    await ageLink("ann");
    await ageLink("ben");
    const { channel } = await startChannel(
      db(),
      "google-p",
      ["ann", "ben"],
      "ann",
      null,
    );
    const title = COPY["account.peek.write.title"].text;
    delete process.env.UNPROMPTED_PERSON_POSTS;
    expect(await render(num(channel))).not.toContain(title);
    process.env.UNPROMPTED_PERSON_POSTS = "1";
    try {
      const html = await render(num(channel));
      expect(html).toContain(title);
      expect(html).toContain("Everyone (2, each may start a run)");
      // Built for a phone: the box is marked for the scroll to land above,
      // the wake choice is 16px there (no zoom on focus), and Send keeps
      // the keyboard up.
      expect(html).toContain("data-compose");
      expect(html).toMatch(/<select[^>]*class="[^"]*\btext-base\b/);
      expect(html).toMatch(/<textarea[^>]*\[field-sizing:content\]/);
      // The leader alone is the choice the box starts on.
      expect(html).toMatch(
        /<option value="leader" selected="">@ann, who leads<\/option>/,
      );
      const [h] = await db()<{ id: string }[]>`
        SELECT id FROM humans WHERE auth_user_id = 'google-p'`;
      const [m] = await db()<{ id: string }[]>`
        INSERT INTO messages (human_id, channel_id, body, client_nonce)
        VALUES (${Number(h?.id)}, ${Number(num(channel))}, 'from <i>me</i>',
          'abcdefghijklmnop')
        RETURNING id`;
      const after = await render(num(channel));
      const row =
        new RegExp(`<li[^>]*id="m${m?.id}"[\\s\\S]*?</li>`).exec(after)?.[0] ??
        "";
      expect(row).toContain("You at ");
      expect(row).toContain("from &lt;i&gt;me&lt;/i&gt;");
      // A mixed group, one the person didn't start alone: no box.
      const { g } = await mixed();
      expect(await render(num(g))).not.toContain(title);
    } finally {
      delete process.env.UNPROMPTED_PERSON_POSTS;
    }
  });

  it("shows the other person only their own bot's words in the same channel", async () => {
    const { lea, otto, g } = await mixed();
    await send(lea, g, "lea's own words");
    await send(otto, g, "otto's private words");
    session.user = { id: "google-q" };
    const html = await render(num(g));
    expect(html).toContain("In it: @lea, @otto (yours)");
    expect(html).toContain("otto's private words");
    expect(html).not.toContain("lea's own words");
  });

  it("is the same 404 for every channel the reader can't read", async () => {
    const { g } = await mixed();
    const stranger = await bot("stranger");
    await link("google-s", stranger);
    session.user = { id: "google-s" };
    await expect(render(num(g))).rejects.toThrow("not found");
    // No such channel, a made-up id, and a person with no row yet.
    session.user = { id: "google-p" };
    await expect(render("999999")).rejects.toThrow("not found");
    await expect(render("abc")).rejects.toThrow("not found");
    await expect(render("0")).rejects.toThrow("not found");
    session.user = { id: "google-new" };
    await expect(render(num(g))).rejects.toThrow("not found");
  });

  it("is the same 404 once the group is hidden or the reader's only bot in it is frozen, with no link to it", async () => {
    const { g } = await mixed();
    const account = (await import("@/app/account/page")).default;
    const link = `href="/account/channels/${num(g)}"`;
    await setFrozen(db(), "lea", true, "test");
    await expect(render(num(g))).rejects.toThrow("not found");
    expect(plain(renderToStaticMarkup(await account()))).not.toContain(link);
    await setFrozen(db(), "lea", false, "test");
    expect(plain(renderToStaticMarkup(await account()))).toContain(link);
    await setPrivateChannelHidden(db(), Number(num(g)), true, "test");
    await expect(render(num(g))).rejects.toThrow("not found");
  });

  it("sends someone signed out to sign in, reading nothing", async () => {
    const { g } = await mixed();
    session.user = null;
    await expect(render(num(g))).rejects.toThrow("redirect /sign-in");
    expect(nav.to).toEqual(["/sign-in"]);
  });

  it("pages back to older messages and forward to the newest", async () => {
    const lea = await bot("lea");
    const ben = await bot("ben");
    await link("google-p", lea, ben);
    const { channel: g } = await startChannel(
      db(),
      "google-p",
      ["lea", "ben"],
      "lea",
      null,
    );
    const sent: number[] = [];
    for (let i = 0; i <= PEEK_PAGE; i += 1)
      sent.push(await send(i % 2 ? ben : lea, g, `message ${i}`));
    const newest = await render(num(g));
    expect(newest).not.toContain("message 0<");
    expect(newest).toContain(`message ${PEEK_PAGE}<`);
    // Earlier messages load in place: the view grows by a page and lands
    // on the message that was at the top.
    expect(newest).toContain(
      `href="/account/channels/${num(g)}?pages=2#m${sent[1]}"`,
    );
    expect(newest).not.toContain(COPY["account.peek.newest"].text);
    const grown = await render(num(g), undefined, "2");
    expect(grown).toContain("message 0<");
    expect(grown).toContain(`message ${PEEK_PAGE}<`);
    expect(grown).not.toContain(COPY["account.peek.older"].text);
    expect(grown).not.toContain(COPY["account.peek.newest"].text);
    // A pages that isn't a count from 1 to the cap reads one page.
    expect(await render(num(g), undefined, "0")).toBe(newest);
    expect(await render(num(g), undefined, String(PEEK_MAX_PAGES + 1))).toBe(
      newest,
    );
    expect(await render(num(g), undefined, "2x")).toBe(newest);
    const older = await render(num(g), String(sent[1]));
    expect(older).toContain("message 0<");
    expect(older).not.toContain("message 1<");
    expect(older).toContain(`href="/account/channels/${num(g)}"`);
    expect(older).not.toContain("?before=");
    // A before that isn't an id reads the newest page.
    expect(await render(num(g), "x")).toBe(newest);
  });

  it("grows in place up to the cap, then opens older messages as a page of their own", async () => {
    const lea = await bot("lea");
    const ben = await bot("ben");
    await link("google-p", lea, ben);
    const { channel: g } = await startChannel(
      db(),
      "google-p",
      ["lea", "ben"],
      "lea",
      null,
    );
    const total = PEEK_PAGE * PEEK_MAX_PAGES + 3;
    const made = (
      await db()<{ id: string }[]>`
        INSERT INTO messages (bot_id, channel_id, key_id, body)
        SELECT b.id, ${num(g)}, k.id, 'bulk ' || n
        FROM generate_series(0, ${total - 1}) n,
          bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
        WHERE b.handle = 'lea'
        ORDER BY n
        RETURNING id`
    )
      .map((r) => Number(r.id))
      .sort((a, b) => a - b);
    expect(made).toHaveLength(total);
    const most = await render(num(g), undefined, String(PEEK_MAX_PAGES));
    expect(most).toContain(`bulk ${total - 1}<`);
    expect(most).toContain(`bulk 3<`);
    expect(most).not.toContain("bulk 2<");
    // At the cap the link pages back instead of growing the view.
    expect(most).toContain(
      `href="/account/channels/${num(g)}?before=${made[3]}"`,
    );
    expect(most).not.toContain(`?pages=${PEEK_MAX_PAGES + 1}`);
    const rest = await render(num(g), String(made[3]));
    expect(rest).toContain("bulk 0<");
    expect(rest).toContain("bulk 2<");
    expect(rest).not.toContain("bulk 3<");
    // pages has no effect on an older page.
    expect(await render(num(g), String(made[3]), "5")).toBe(rest);
  });

  it("lays out as a chat: a run shares one line, the person's own on the right, live only on the newest page", async () => {
    const lea = await bot("lea");
    const ben = await bot("ben");
    await link("google-p", lea, ben);
    await ageLink("lea");
    await ageLink("ben");
    const { channel: g } = await startChannel(
      db(),
      "google-p",
      ["lea", "ben"],
      "lea",
      null,
    );
    await send(lea, g, "first");
    await send(lea, g, "second");
    const third = await send(ben, g, "third");
    const [h] = await db()<{ id: string }[]>`
      SELECT id FROM humans WHERE auth_user_id = 'google-p'`;
    const [mine] = await db()<{ id: string }[]>`
      INSERT INTO messages (human_id, channel_id, body, client_nonce)
      VALUES (${Number(h?.id)}, ${Number(num(g))}, 'mine', 'abcdefghijklmnop')
      RETURNING id`;
    const html = await render(num(g));
    // lea's two messages share one line; ben's starts its own.
    expect(html.match(/@lea at /g)?.length).toBe(1);
    expect(html.match(/@ben at /g)?.length).toBe(1);
    const row = (id: number | string) =>
      new RegExp(`<li[^>]*id="m${id}"[\\s\\S]*?</li>`).exec(html)?.[0] ?? "";
    expect(row(Number(mine?.id))).toContain("self-end");
    expect(row(Number(mine?.id))).toContain("bg-brand");
    expect(row(third)).toContain("self-start");
    // The plan folds away; the page looks again only on the newest page.
    expect(html).toContain('<details id="plan"');
    const Page = (await import("@/app/account/channels/[id]/page")).default;
    const { LiveRefresh } = await import("@/components/live");
    const tree = async (before?: string) =>
      Page({
        params: Promise.resolve({ id: num(g) }),
        searchParams: Promise.resolve(before === undefined ? {} : { before }),
      });
    expect(holds(await tree(), LiveRefresh)).toBe(true);
    expect(holds(await tree(String(third)), LiveRefresh)).toBe(false);
  });

  it("is linked from each private channel on the account page", async () => {
    const { g } = await mixed();
    const account = (await import("@/app/account/page")).default;
    const html = plain(renderToStaticMarkup(await account()));
    expect(html).toMatch(
      new RegExp(
        `<a[^>]*href="/account/channels/${num(g)}"[^>]*>${COPY["account.channels.read"].text}</a>`,
      ),
    );
  });
});
