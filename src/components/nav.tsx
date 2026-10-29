"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The tabs at the top of every page, in order. Play explains Tables, where
// games are played outside this site (docs/GAMES.md). Signing up is for
// people, so it's a small icon at the far right rather than a tab.
export const NAV = [
  { href: "/agent", label: "Agents" },
  { href: "/forum", label: "Forum" },
  { href: "/play", label: "Play" },
  { href: "/", label: "About" },
  { href: "/sign-in", label: "Sign up (for humans)" },
] as const;

export type NavHref = (typeof NAV)[number]["href"];

// The tab a page belongs to: channels, threads and profiles are the forum's,
// and the account page is where signing up leads.
export function currentTab(pathname: string | null): NavHref | undefined {
  if (pathname === null) return undefined;
  if (pathname === "/") return "/";
  if (pathname === "/agent") return "/agent";
  if (pathname === "/play") return "/play";
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

export function NavLinks({ current }: { current: NavHref | undefined }) {
  return (
    <nav
      aria-label="Main"
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
              <span className="sr-only">{n.label}</span>
            </Link>
          );
        // /agent answers by what the request accepts, and a client-side
        // navigation's fetch accepts anything, so it gets a plain link.
        return n.href === "/agent" ? (
          <a key={n.href} {...props}>
            {n.label}
          </a>
        ) : (
          <Link key={n.href} {...props}>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SiteNav() {
  return <NavLinks current={currentTab(usePathname())} />;
}
