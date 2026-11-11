import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type NavLabels,
  NavLinks,
  navCurrent,
  SIGNED_OUT,
} from "@/components/nav";
import { adminHome } from "@/lib/admin-home";
import { COPY } from "@/lib/copy";
import { DEFAULT_NEXT, safeNext, signInPath } from "@/lib/sign-in-next";

// Signing in says where you are: the far right of every page says whether
// you're signed in and, for admins, links to the admin pages; the sign-in
// page says what signing in gives you, and sends you back to the page that
// asked you to sign in, never anywhere else.

const auth = vi.hoisted(() => ({
  enabled: true,
  user: null as null | { id: string; email: string | null },
  role: undefined as undefined | "admin" | "copy",
  fails: false,
  middleware: [] as string[],
}));
const nav = vi.hoisted(() => ({ redirects: [] as string[] }));

vi.mock("@/lib/human-auth", () => ({
  humanSignInEnabled: () => auth.enabled,
  sessionUser: async () => {
    if (auth.fails) throw new Error("auth server down");
    return auth.user;
  },
  neonAuth: () =>
    auth.enabled
      ? {
          middleware: ({ loginUrl }: { loginUrl: string }) => {
            auth.middleware.push(loginUrl);
            return async () => new Response(null, { status: 200 });
          },
        }
      : undefined,
}));
vi.mock("@/lib/admins", () => ({
  roleFor: async () =>
    auth.role ? { humanId: 1, role: auth.role } : undefined,
}));
vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@/lib/page-copy", async () => {
  const { COPY } = await import("@/lib/copy");
  return {
    pageCopy: async () =>
      Object.fromEntries(Object.entries(COPY).map(([k, v]) => [k, v.text])),
  };
});
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.redirects.push(to);
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
  usePathname: () => "/",
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(() => {
  auth.enabled = true;
  auth.user = null;
  auth.role = undefined;
  auth.fails = false;
  auth.middleware = [];
  nav.redirects = [];
});

const LABELS: NavLabels = {
  label: COPY["site.nav.label"].text,
  "/agent": COPY["site.nav.agents"].text,
  "/forum": COPY["site.nav.forum"].text,
  "/play": COPY["site.nav.play"].text,
  "/": COPY["site.nav.about"].text,
  "/sign-in": COPY["site.nav.sign_up"].text,
  account: COPY["site.nav.account"].text,
  admin: COPY["site.nav.admin"].text,
};

const text = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");

describe("where sign-in sends you back to", () => {
  it("is the account page or an admin page", () => {
    for (const ok of [
      "/account",
      "/admin",
      "/admin/copy",
      "/admin/copy/home.tagline",
      "/admin/bots/alice-2",
      "/admin/for-bots/channels/meta",
      "/admin/humans/12",
    ])
      expect(safeNext(ok), ok).toBe(ok);
  });

  it("is never another site, another page, or a path that climbs out", () => {
    for (const bad of [
      undefined,
      null,
      42,
      ["/admin"],
      "",
      "/",
      "/forum",
      "/accounts",
      "/account/",
      "/adminx",
      "/admin/",
      "/admin//copy",
      "/admin/..",
      "/admin/../forum",
      "/admin/./copy",
      "/admin/.hidden",
      "/admin/%2e%2e/x",
      "/admin/copy?x=1",
      "/admin/copy#keys",
      "/admin\\evil",
      "/admin/copy\\..",
      "//evil.example/admin",
      "https://evil.example/admin",
      "javascript:alert(1)",
      " /admin",
      "/admin/copy\n",
      `/admin/${"a".repeat(300)}`,
    ])
      expect(safeNext(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it("travels in the sign-in page's address, and only when it's needed", () => {
    expect(signInPath("/admin/copy")).toBe("/sign-in?next=%2Fadmin%2Fcopy");
    expect(signInPath("/admin")).toBe("/sign-in?next=%2Fadmin");
    expect(signInPath(DEFAULT_NEXT)).toBe("/sign-in");
    expect(signInPath("//evil.example")).toBe("/sign-in");
    expect(signInPath(undefined)).toBe("/sign-in");
  });

  it("is what the proxy asks for when an admin page needs signing in", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    await proxy(new NextRequest("https://site.example/admin/copy"));
    await proxy(new NextRequest("https://site.example/admin/copy/home.intro"));
    await proxy(new NextRequest("https://site.example/account"));
    expect(auth.middleware).toEqual([
      "/sign-in?next=%2Fadmin%2Fcopy",
      "/sign-in?next=%2Fadmin%2Fcopy%2Fhome.intro",
      "/sign-in",
    ]);
  });
});

describe("the far right of every page", () => {
  it("says sign up, in words, when nobody's signed in", () => {
    const html = renderToStaticMarkup(
      createElement(NavLinks, { current: undefined, labels: LABELS }),
    );
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain("<span>Sign up (for humans)</span>");
    expect(html).not.toContain('href="/account"');
    expect(html).not.toMatch(/href="\/admin/);
    expect(html).not.toContain("bg-green-600");
  });

  it("says you're signed in, with a dot and a link to your account", () => {
    const html = renderToStaticMarkup(
      createElement(NavLinks, {
        current: undefined,
        labels: LABELS,
        who: { signedIn: true, admin: null },
      }),
    );
    expect(html).toMatch(
      /<a [^>]*href="\/account"[^>]*>(?:(?!<\/a>)[\s\S])*bg-green-600(?:(?!<\/a>)[\s\S])*<span>Your account<\/span>/,
    );
    expect(html).not.toContain('href="/sign-in"');
    expect(html).not.toMatch(/href="\/admin/);
  });

  it("names nobody: no email, no handle, only that someone is signed in", () => {
    const html = renderToStaticMarkup(
      createElement(NavLinks, {
        current: undefined,
        labels: LABELS,
        who: { signedIn: true, admin: "admin" },
      }),
    );
    expect(html).not.toContain("@");
  });

  it("gives an admin a link to the admin pages, and a copy editor one to the words", () => {
    const admin = renderToStaticMarkup(
      createElement(NavLinks, {
        current: undefined,
        labels: LABELS,
        who: { signedIn: true, admin: "admin" },
      }),
    );
    expect(admin).toMatch(/<a [^>]*href="\/admin"[^>]*>Admin<\/a>/);
    const copy = renderToStaticMarkup(
      createElement(NavLinks, {
        current: undefined,
        labels: LABELS,
        who: { signedIn: true, admin: "copy" },
      }),
    );
    expect(copy).toMatch(/<a [^>]*href="\/admin\/copy"[^>]*>Admin<\/a>/);
    expect(copy).not.toMatch(/href="\/admin"/);
    expect(adminHome("admin")).toBe("/admin");
    expect(adminHome("copy")).toBe("/admin/copy");
  });

  it("marks the admin link while you're on an admin page", () => {
    expect(navCurrent("/admin")).toBe("admin");
    expect(navCurrent("/admin/copy/home.tagline")).toBe("admin");
    expect(navCurrent("/adminx")).toBeUndefined();
    expect(navCurrent("/account")).toBe("/sign-in");
    expect(navCurrent("/forum")).toBe("/forum");
    const html = renderToStaticMarkup(
      createElement(NavLinks, {
        current: "admin",
        labels: LABELS,
        who: { signedIn: true, admin: "admin" },
      }),
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(/<a [^>]*aria-current="page"[^>]*>/.exec(html)?.[0]).toContain(
      'href="/admin"',
    );
  });

  it("reads who's here from the session, and shows signed out if it can't", async () => {
    const { navWho } = await import("@/lib/nav-who");
    expect(await navWho()).toEqual(SIGNED_OUT);
    auth.user = { id: "g-1", email: "ada@example.com" };
    expect(await navWho()).toEqual({ signedIn: true, admin: null });
    auth.role = "copy";
    expect(await navWho()).toEqual({ signedIn: true, admin: "copy" });
    auth.role = "admin";
    expect(await navWho()).toEqual({ signedIn: true, admin: "admin" });
    auth.enabled = false;
    expect(await navWho()).toEqual(SIGNED_OUT);
    auth.enabled = true;
    auth.fails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await navWho()).toEqual(SIGNED_OUT);
    expect(warn).toHaveBeenCalledWith("couldn't read who's signed in", {
      error: "auth server down",
    });
    warn.mockRestore();
  });

  it("is drawn on every page by the layout, from the session", async () => {
    const RootLayout = (await import("@/app/layout")).default;
    const out = renderToStaticMarkup(
      await RootLayout({ children: createElement("p", null, "page") }),
    );
    expect(out).toContain('href="/sign-in"');
    auth.user = { id: "g-1", email: "ada@example.com" };
    auth.role = "admin";
    const signedIn = renderToStaticMarkup(
      await RootLayout({ children: createElement("p", null, "page") }),
    );
    expect(signedIn).toContain('href="/account"');
    expect(signedIn).toMatch(/href="\/admin"[^>]*>Admin</);
    expect(signedIn).not.toContain("ada@example.com");
  });
});

async function signInPage(params: Record<string, string> = {}) {
  const page = (await import("@/app/sign-in/page")).default;
  return text(
    renderToStaticMarkup(await page({ searchParams: Promise.resolve(params) })),
  );
}

describe("the sign-in page", () => {
  it("says what signing in gives you, and what needs no account", async () => {
    const html = await signInPage();
    expect(html).toContain(COPY["sign_in.gives.title"].text);
    expect(html).toContain(COPY["sign_in.gives.agents"].text);
    expect(html).toContain(COPY["sign_in.gives.admins"].text);
    expect(html).toContain(COPY["sign_in.gives.none"].text);
    expect(html).toContain("Sign in with Google");
  });

  it("says where you'll go on to, and carries it through Google", async () => {
    const html = await signInPage({ next: "/admin/copy" });
    expect(html).toContain("Sign in to go on to /admin/copy.");
    expect(html).toMatch(
      /<input type="hidden" name="next" value="\/admin\/copy"\/>/,
    );
  });

  it("carries nothing it wouldn't send you back to", async () => {
    for (const next of ["//evil.example", "/forum", "/admin/../x"]) {
      const html = await signInPage({ next });
      expect(html, next).not.toContain('name="next"');
      expect(html, next).not.toContain("go on to");
      expect(html, next).not.toContain("evil.example");
    }
    // The account page is where it sends you anyway.
    const account = await signInPage({ next: "/account" });
    expect(account).not.toContain("go on to");
  });

  it("tells someone signed in that they are, instead of offering Google again", async () => {
    auth.user = { id: "g-1", email: "ada@example.com" };
    const html = await signInPage();
    expect(html).toContain("You're signed in as ada@example.com.");
    expect(html).not.toContain("Sign in with Google");
    expect(html).toContain('href="/account"');
    expect(html).toContain("Sign out");
    expect(html).not.toMatch(/href="\/admin/);
    expect(html).toContain(COPY["sign_in.gives.title"].text);
  });

  it("shows an admin where the admin pages are, and a copy editor the words", async () => {
    auth.user = { id: "g-1", email: null };
    auth.role = "admin";
    const admin = await signInPage();
    expect(admin).toContain("You're signed in.");
    expect(admin).toMatch(/href="\/admin"[^>]*>Admin</);
    auth.role = "copy";
    expect(await signInPage()).toMatch(/href="\/admin\/copy"[^>]*>Admin</);
  });

  it("sends someone already signed in straight on to the page they came from", async () => {
    auth.user = { id: "g-1", email: null };
    await expect(signInPage({ next: "/admin/copy" })).rejects.toThrow(
      "redirect /admin/copy",
    );
    await signInPage({ next: "//evil.example" });
    expect(nav.redirects).toEqual(["/admin/copy"]);
  });

  it("shows as signed out when the session can't be read", async () => {
    auth.fails = true;
    const html = await signInPage();
    expect(html).toContain("Sign in with Google");
  });

  it("says signing in isn't available where it isn't set up", async () => {
    auth.enabled = false;
    auth.user = { id: "g-1", email: null };
    const html = await signInPage({ next: "/admin/copy" });
    expect(html).toContain(COPY["sign_in.unavailable"].text);
    expect(html).not.toContain('name="next"');
    expect(nav.redirects).toEqual([]);
  });
});

describe("the admin pages' bar", () => {
  async function bar() {
    const AdminLayout = (await import("@/app/admin/layout")).default;
    return text(
      renderToStaticMarkup(
        await AdminLayout({ children: createElement("p", null, "inside") }),
      ),
    );
  }

  it("says who's signed in and as what, with a way out", async () => {
    auth.user = { id: "g-1", email: "ada@example.com" };
    auth.role = "admin";
    const html = await bar();
    expect(html).toContain("Signed in as ada@example.com, admin");
    expect(html).toContain('href="/account"');
    expect(html).toContain("Sign out");
    expect(html).toContain("inside");
    auth.role = "copy";
    expect(await bar()).toContain("Signed in as ada@example.com, copy editor");
  });

  it("tells someone in with the wrong Google account that it isn't an admin", async () => {
    auth.user = { id: "g-2", email: "eve@example.com" };
    expect(await bar()).toContain("Signed in as eve@example.com, not an admin");
  });

  it("draws nothing when nobody's signed in, or the session can't be read", async () => {
    expect(await bar()).toBe("<p>inside</p>");
    auth.fails = true;
    expect(await bar()).toBe("<p>inside</p>");
  });
});
