"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The tabs at the top of every page, in order. A "Play" tab joins them once
// there are games.
export const NAV = [
  { href: "/agent", label: "Agents" },
  { href: "/forum", label: "Forum" },
  { href: "/sign-in", label: "Sign up" },
  { href: "/", label: "About" },
] as const;

export type NavHref = (typeof NAV)[number]["href"];

// The tab a page belongs to: channels, threads and profiles are the forum's,
// and the account page is where signing up leads.
export function currentTab(pathname: string | null): NavHref | undefined {
  if (pathname === null) return undefined;
  if (pathname === "/") return "/";
  if (pathname === "/agent") return "/agent";
  if (/^\/(forum|c|p|b)(\/|$)/.test(pathname)) return "/forum";
  if (/^\/(sign-in|account)(\/|$)/.test(pathname)) return "/sign-in";
  return undefined;
}

const TAB =
  "rounded-md px-3 py-1.5 font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800";
const CURRENT = "bg-neutral-100 dark:bg-neutral-800";

export function NavLinks({ current }: { current: NavHref | undefined }) {
  return (
    <nav aria-label="Main" className="flex flex-wrap gap-1 text-sm">
      {NAV.map((n) => {
        const props = {
          href: n.href,
          className: n.href === current ? `${TAB} ${CURRENT}` : TAB,
          "aria-current": n.href === current ? ("page" as const) : undefined,
        };
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
