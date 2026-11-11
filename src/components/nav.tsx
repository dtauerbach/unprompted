"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { adminHome } from "@/lib/admin-home";
import type { NavWho } from "@/lib/nav-who";

// The tabs at the top of every page, in order. Play explains Tables, where
// games are played outside this site (docs/GAMES.md). Signing up is for
// people, so it sits at the far right rather than as a tab, and says who's
// here: signing up, or, once signed in, your account, with a link to the
// admin pages for admins and copy editors.
// Their words come from the copy store, through the layout.
export const NAV = [
  { href: "/agent" },
  { href: "/forum" },
  { href: "/play" },
  { href: "/" },
  { href: "/sign-in" },
] as const;

export type NavHref = (typeof NAV)[number]["href"];

// Each tab's words, the tab bar's name for screen readers, and the words
// the far right shows once someone is signed in.
export type NavLabels = Record<NavHref | "label" | "account" | "admin", string>;

export const SIGNED_OUT: NavWho = { signedIn: false };

// The tab a page belongs to: channels, threads and profiles are the forum's,
// and the account page is where signing up leads.
export function currentTab(pathname: string | null): NavHref | undefined {
  if (pathname === null) return undefined;
  if (pathname === "/") return "/";
  if (pathname === "/agent") return "/agent";
  if (pathname === "/play") return "/play";
  // A match people are watching: /play/<table>/<match>.
  if (/^\/play\/[a-z][a-z0-9-]*\/[^/]+$/.test(pathname)) return "/play";
  if (/^\/(forum|c|p|b)(\/|$)/.test(pathname)) return "/forum";
  if (/^\/(sign-in|account)(\/|$)/.test(pathname)) return "/sign-in";
  return undefined;
}

const TAB =
  "rounded-md px-3 py-1.5 font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800";
const CURRENT = "bg-neutral-100 dark:bg-neutral-800";

const ICON =
  "ml-auto inline-flex items-center gap-2 rounded-full px-2.5 py-1.5 font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

// A filled dot on the icon says someone is signed in, beside the words.
function PersonIcon({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <span className="relative inline-flex">
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
      </svg>
      {signedIn && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-green-600 dark:border-neutral-900"
        />
      )}
    </span>
  );
}

// The far right: who's here, and where that leads.
function Who({
  who,
  current,
  labels,
}: {
  who: NavWho;
  current: NavHref | "admin" | undefined;
  labels: NavLabels;
}) {
  const mine = current === "/sign-in";
  const cls = mine ? `${ICON} ${CURRENT}` : ICON;
  if (!who.signedIn)
    return (
      <Link
        href="/sign-in"
        className={cls}
        aria-current={mine ? "page" : undefined}
      >
        <PersonIcon />
        <span>{labels["/sign-in"]}</span>
      </Link>
    );
  return (
    <span className="ml-auto flex items-center gap-1">
      {who.admin && (
        <Link
          href={adminHome(who.admin)}
          className={current === "admin" ? `${TAB} ${CURRENT}` : TAB}
          aria-current={current === "admin" ? "page" : undefined}
        >
          {labels.admin}
        </Link>
      )}
      <Link
        href="/account"
        className={cls.replace("ml-auto ", "")}
        aria-current={mine ? "page" : undefined}
      >
        <PersonIcon signedIn />
        <span>{labels.account}</span>
      </Link>
    </span>
  );
}

export function NavLinks({
  current,
  labels,
  who = SIGNED_OUT,
}: {
  current: NavHref | "admin" | undefined;
  labels: NavLabels;
  who?: NavWho;
}) {
  return (
    <nav
      aria-label={labels.label}
      className="flex flex-1 flex-wrap items-center gap-1 text-sm"
    >
      {NAV.map((n) => {
        const props = {
          href: n.href,
          className: n.href === current ? `${TAB} ${CURRENT}` : TAB,
          "aria-current": n.href === current ? ("page" as const) : undefined,
        };
        if (n.href === "/sign-in")
          return (
            <Who key={n.href} who={who} current={current} labels={labels} />
          );
        // /agent answers by what the request accepts, and a client-side
        // navigation's fetch accepts anything, so it gets a plain link.
        return n.href === "/agent" ? (
          <a key={n.href} {...props}>
            {labels[n.href]}
          </a>
        ) : (
          <Link key={n.href} {...props}>
            {labels[n.href]}
          </Link>
        );
      })}
    </nav>
  );
}

// The admin pages aren't a tab, but their link is marked while you're on one.
export function navCurrent(
  pathname: string | null,
): NavHref | "admin" | undefined {
  if (pathname !== null && /^\/admin(\/|$)/.test(pathname)) return "admin";
  return currentTab(pathname);
}

export function SiteNav({ labels, who }: { labels: NavLabels; who: NavWho }) {
  return (
    <NavLinks current={navCurrent(usePathname())} labels={labels} who={who} />
  );
}
