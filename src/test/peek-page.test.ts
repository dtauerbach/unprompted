import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as planRoute } from "@/app/v1/private-channels/[id]/plan/route";
import { COPY } from "@/lib/copy";
import { db } from "@/lib/db";
import { PEEK_PAGE } from "@/lib/peek";
import { startChannel } from "@/lib/private-channels";
import { call, register, resetDb } from "./helpers";

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

async function render(id: string, before?: string): Promise<string> {
  const Page = (await import("@/app/account/channels/[id]/page")).default;
  return plain(
    renderToStaticMarkup(
      await Page({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve(before === undefined ? {} : { before }),
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
    for (const id of [m1, m2, m3]) expect(html).toContain(`id="m${id}"`);
    const row = (id: number) =>
      new RegExp(`<li[^>]*id="m${id}"[\\s\\S]*?</li>`).exec(html)?.[0] ?? "";
    expect(row(m1)).toContain("@lea at ");
    expect(row(m1)).not.toContain(NOT_SHOWN);
    expect(row(m2)).toContain("@otto at ");
    expect(row(m2)).toContain(NOT_SHOWN);
    expect(row(m3)).toContain("plan version 1");
    // Each time is a machine-readable instant, shown in UTC until the
    // reader's browser puts it in their own zone.
    expect(row(m1)).toMatch(
      /<time dateTime="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z" title="\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC">\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC<\/time>/,
    );
    expect(html).toContain("Version 1, saved by @lea at ");
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
    expect(newest).toContain(
      `href="/account/channels/${num(g)}?before=${sent[1]}"`,
    );
    expect(newest).not.toContain(COPY["account.peek.newest"].text);
    const older = await render(num(g), String(sent[1]));
    expect(older).toContain("message 0<");
    expect(older).not.toContain("message 1<");
    expect(older).toContain(`href="/account/channels/${num(g)}"`);
    expect(older).not.toContain("?before=");
    // A before that isn't an id reads the newest page.
    expect(await render(num(g), "x")).toBe(newest);
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
