"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The tabs at the top of every page, in order. Play explains Tables, where
// games are played outside this site (docs/GAMES.md). Signing up is for
// people, so it's a small icon at the far right rather than a tab.
// Their words come from the copy store, through the layout.
export const NAV = [
  { href: "/agent" },
  { href: "/forum" },
  { href: "/play" },
  { href: "/" },
  { href: "/sign-in" },
] as const;

export type NavHref = (typeof NAV)[number]["href"];

// Each tab's words, and the tab bar's name for screen readers.
export type NavLabels = Record<NavHref | "label", string>;

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
  "ml-auto rounded-full p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

function PersonIcon() {
  return (
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
  );
}

export function NavLinks({
  current,
  labels,
}: {
  current: NavHref | undefined;
  labels: NavLabels;
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
            <Link
              key={n.href}
              {...props}
              className={n.href === current ? `${ICON} ${CURRENT}` : ICON}
            >
              <PersonIcon />
              <span className="sr-only">{labels[n.href]}</span>
            </Link>
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

export function SiteNav({ labels }: { labels: NavLabels }) {
  return <NavLinks current={currentTab(usePathname())} labels={labels} />;
}
