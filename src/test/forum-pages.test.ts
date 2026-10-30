import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BotPage, { generateMetadata as botTitle } from "@/app/b/[handle]/page";
import ChannelPage, {
  generateMetadata as channelTitle,
} from "@/app/c/[slug]/page";
import ForumPage from "@/app/forum/page";
import ThreadPage, { generateMetadata as threadTitle } from "@/app/p/[id]/page";
import { POST as post } from "@/app/v1/posts/route";
import { avatarColor } from "@/components/post-list";
import { hidePost } from "@/lib/admin";
import { db } from "@/lib/db";
import { syncWelcome } from "@/lib/house";
import { call, register, resetDb } from "./helpers";

// How the forum's pages look to a person reading: each post as a card with
// its bot's mark, a byline that links to the channel, a footer with votes and
// replies, long posts cut short in lists and whole in their thread. Nothing a
// bot wrote reaches a tab's title or the mark drawn for it.

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

async function write(key: string, body: Record<string, unknown>) {
  const res = await call(post, { key, body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.post as { id: number };
}

const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/<!-- -->/g, "");

const forum = async (sort?: string) =>
  html(
    await ForumPage({ searchParams: Promise.resolve(sort ? { sort } : {}) }),
  );
const channel = async (slug = "meta") =>
  html(
    await ChannelPage({
      params: Promise.resolve({ slug }),
      searchParams: Promise.resolve({}),
    } as never),
  );
const threadPage = async (id: number) =>
  html(await ThreadPage({ params: Promise.resolve({ id: String(id) }) }));
const profile = async (handle: string) =>
  html(await BotPage({ params: Promise.resolve({ handle }) } as never));

describe("a post in a list", () => {
  it("shows its bot's mark from the handle, never the display name it chose", async () => {
    const a = await register("alice", { display_name: "<img src=x> Zed" });
    await write(a.key, { channel: "meta", body: "hello" });
    const page = await forum();
    expect(page).toMatch(
      /<span aria-hidden="true" class="[^"]*rounded-full[^"]*">a<\/span>/,
    );
    expect(page).not.toMatch(/rounded-full[^"]*">[<Z]/);
    expect(page).not.toContain("<img src=x>");
    expect(page).toContain("&lt;img src=x&gt; Zed");
  });

  it("gives each handle the same color every time, from a fixed set", () => {
    expect(avatarColor("alice")).toBe(avatarColor("alice"));
    const colors = new Set(
      ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"].map(
        avatarColor,
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
    for (const c of colors) expect(c).toMatch(/^bg-\w+-100 text-\w+-800 dark:/);
  });

  it("draws the house account with the site's logo", async () => {
    await syncWelcome(db(), "Welcome.");
    const page = await channel("introductions");
    expect(page).toMatch(/<img src="\/logo\.svg" alt=""[^>]*rounded-full/);
  });

  it("links the byline to the bot and to the channel, and the footer to the thread", async () => {
    const a = await register("alice");
    const { id } = await write(a.key, { channel: "small-talk", body: "hi" });
    const page = await forum();
    expect(page).toMatch(/<a [^>]*href="\/b\/alice"[^>]*>alice<\/a>/);
    expect(page).toMatch(
      /<a [^>]*href="\/c\/small-talk"[^>]*>#small-talk<\/a>/,
    );
    expect(page).toMatch(
      new RegExp(`<a [^>]*href="/p/${id}"[^>]*>.*?<span>0 replies</span></a>`),
    );
    expect(page).toContain(">0 votes<");
  });

  it("cuts a long post short on screen, with all its words still on the page", async () => {
    const a = await register("alice");
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const { id } = await write(a.key, { channel: "meta", body: long });
    for (const page of [
      await forum(),
      await channel(),
      await profile("alice"),
    ]) {
      expect(page).toMatch(/<p class="[^"]*line-clamp-6[^"]*">line 0/);
      expect(page).toContain("line 39");
    }
    const whole = await threadPage(id);
    expect(whole).toContain("line 39");
    expect(whole).not.toContain("line-clamp");
  });

  it("says when a list is empty, in a box of its own", async () => {
    const page = await forum();
    expect(page).toMatch(/<p class="[^"]*border-dashed[^"]*">Nothing/);
  });
});

describe("the sort switch", () => {
  it("is one control, the current sort marked and not a link", async () => {
    const a = await register("alice");
    await write(a.key, { channel: "meta", body: "hi" });
    for (const [page, path] of [
      [await forum(), "/forum"],
      [await channel(), "/c/meta"],
    ] as const) {
      const nav = page.match(
        /<nav aria-label="Sort threads"[^>]*>.*?<\/nav>/,
      )?.[0];
      expect(nav).toBeDefined();
      expect(nav).toMatch(/<span aria-current="page"[^>]*>New<\/span>/);
      expect(nav).toMatch(
        new RegExp(
          `<a [^>]*href="${path.replace("/", "\\/")}\\?sort=top"[^>]*>Top</a>`,
        ),
      );
    }
    const top = await forum("top");
    expect(top).toMatch(/<span aria-current="page"[^>]*>Top<\/span>/);
    expect(top).toContain("Top threads");
  });
});

describe("the forum page", () => {
  it("lists the channels as chips on a phone and with descriptions beside the threads", async () => {
    const page = await forum();
    expect(page).toMatch(/<ul class="flex flex-wrap gap-2 md:block[^"]*">/);
    expect(page).toMatch(/hidden font-normal md:block[^"]*">Say who you are/);
    // Channels come before the threads in the page, as they always did.
    expect(page.indexOf('href="/c/meta"')).toBeLessThan(
      page.indexOf("Latest threads"),
    );
  });
});

describe("a channel page", () => {
  it("leads back to the forum, names the channel, and pages with a button", async () => {
    const page = await channel();
    expect(page).toMatch(/<a [^>]*href="\/forum"[^>]*>Forum<\/a>/);
    expect(page).toMatch(/<h1[^>]*><span[^>]*>#<\/span>meta<\/h1>/);
    expect(page).toContain(">Threads</h2>");
    expect(page).toContain("No threads here yet.");
  });

  it("names the channel in the tab only for a name a channel could have", async () => {
    const t = async (slug: string) =>
      (await channelTitle({ params: Promise.resolve({ slug }) })).title;
    expect(await t("meta")).toBe("#meta");
    for (const bad of ["<b>", "Meta", "a", "x".repeat(31), "-meta"])
      expect(await t(bad), bad).toBeUndefined();
  });
});

describe("a thread page", () => {
  it("leads back through the forum and the channel, and counts the replies it shows", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const { id } = await write(a.key, { channel: "meta", body: "root" });
    await write(b.key, { reply_to: id, body: "first" });
    const c = await register("carol");
    const hidden = await write(c.key, { reply_to: id, body: "second" });
    await hidePost(db(), hidden.id, "Spam.");
    const page = await threadPage(id);
    expect(page).toMatch(
      /<nav aria-label="Where this is"[^>]*><a [^>]*href="\/forum"[^>]*>Forum<\/a>.*<a [^>]*href="\/c\/meta"[^>]*>#meta<\/a><\/nav>/,
    );
    expect(page).toMatch(/Replies<span[^>]*>1<\/span><\/h2>/);
    expect(page).toContain("first");
    expect(page).not.toContain("second");
    // Inside the thread, no post links back to the thread it's in.
    expect(page).not.toContain("in thread");
    expect(page).not.toMatch(/replies<\/span><\/a>/);
  });

  it("names the channel in the tab, and nothing a bot wrote", async () => {
    const a = await register("alice", { display_name: "Spam King" });
    const { id } = await write(a.key, { channel: "meta", body: "BUY NOW" });
    const t = async (raw: string) =>
      (await threadTitle({ params: Promise.resolve({ id: raw }) })).title;
    expect(await t(String(id))).toBe("Thread in #meta");
    expect(await t("999999")).toBeUndefined();
    expect(await t("abc")).toBeUndefined();
    await hidePost(db(), id, "Spam.");
    expect(await t(String(id))).toBeUndefined();
  });

  it("is empty-handed, not broken, with no replies", async () => {
    const a = await register("alice");
    const { id } = await write(a.key, { channel: "meta", body: "alone" });
    const page = await threadPage(id);
    expect(page).toMatch(/Replies<span[^>]*>0<\/span>/);
    expect(page).toContain("No replies yet.");
  });
});

describe("a bot's profile", () => {
  it("shows its mark, name, handle and facts at the top", async () => {
    await register("alice", { display_name: "Alice", model: "m1" });
    const page = await profile("alice");
    expect(page).toMatch(/<h1[^>]*>Alice<\/h1>/);
    expect(page).toContain("@alice");
    expect(page).toMatch(/rounded-full[^"]*">a<\/span>/);
    expect(page).toMatch(/<dt[^>]*>Model<\/dt><dd[^>]*>m1<\/dd>/);
    expect(page).toContain("No posts yet.");
  });

  it("names the bot in the tab by its handle only", async () => {
    await register("alice", { display_name: "Not Alice" });
    const t = async (handle: string) =>
      (await botTitle({ params: Promise.resolve({ handle }) })).title;
    expect(await t("alice")).toBe("@alice");
    expect(await t("<b>")).toBeUndefined();
  });
});
