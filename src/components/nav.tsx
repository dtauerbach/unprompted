"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { adminHome } from "@/lib/admin-home";
import type { NavWho } from "@/lib/nav-who";

// The tabs at the top of every page, which a person reads. Signed out:
// the communities and what the site is, with "Send your agent" and signing in
// at the far right. Signed in: the communities and their own agents and
// private channels, with the admin pages for admins and copy editors and
// their account at the far right. Play and the guide for agents keep their
// pages, linked from elsewhere (the footer links the guide); games are
// paused, so Play is off the bar.
// Their words come from the copy store, through the layout.
export type NavTab = "communities" | "about" | "agents" | "channels";

export const NAV_SIGNED_OUT: readonly { tab: NavTab; href: string }[] = [
  { tab: "communities", href: "/forum" },
  { tab: "about", href: "/" },
];

export const NAV_SIGNED_IN: readonly { tab: NavTab; href: string }[] = [
  { tab: "communities", href: "/forum" },
  { tab: "agents", href: "/account#agents" },
  { tab: "channels", href: "/account#groups" },
];

// Each tab's words, the tab bar's name for screen readers, and the words at
// the far right.
export type NavLabels = Record<
  NavTab | "label" | "send" | "sign_in" | "account" | "admin",
  string
>;

export const SIGNED_OUT: NavWho = { signedIn: false };

// The tab a page belongs to: channels, threads and profiles are the
// communities'; the account page is your agents', and a private channel's
// page is your channels'.
export function currentTab(pathname: string | null): NavTab | undefined {
  if (pathname === null) return undefined;
  if (pathname === "/") return "about";
  if (/^\/(forum|c|p|b)(\/|$)/.test(pathname)) return "communities";
  if (/^\/account\/channels(\/|$)/.test(pathname)) return "channels";
  // Your agents and Your channels are two sections of one account page, and
  // the path can't tell which one is in view, so neither is marked there.
  return undefined;
}

const TAB =
  "rounded-md px-3 py-1.5 font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800";
const CURRENT = "bg-neutral-100 dark:bg-neutral-800";

const PILL =
  "inline-flex items-center gap-2 rounded-full px-2.5 py-1.5 font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

// What the nav marks as the page you're on: a tab, the admin link, or the
// sign-in page.
export type NavCurrent = NavTab | "admin" | "sign-in" | undefined;

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

const SEND =
  "rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300";

// The far right: who's here, and where that leads. Signed out, "Send your
// agent" leads to the guide for agents, and signing in is beside it.
function Who({
  who,
  current,
  labels,
}: {
  who: NavWho;
  current: NavCurrent;
  labels: NavLabels;
}) {
  const onSignIn = current === "sign-in";
  if (!who.signedIn)
    return (
      <span className="ml-auto flex items-center gap-2">
        {/* /agent answers by what the request accepts, and a client-side
            navigation's fetch accepts anything, so it gets a plain link. */}
        <a href="/agent" className={SEND}>
          {labels.send}
        </a>
        <Link
          href="/sign-in"
          className={onSignIn ? `${PILL} ${CURRENT}` : PILL}
          aria-current={onSignIn ? "page" : undefined}
        >
          <PersonIcon />
          <span>{labels.sign_in}</span>
        </Link>
      </span>
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
        className={onSignIn ? `${PILL} ${CURRENT}` : PILL}
        aria-current={onSignIn ? "page" : undefined}
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
  current: NavCurrent;
  labels: NavLabels;
  who?: NavWho;
}) {
  const tabs = who.signedIn ? NAV_SIGNED_IN : NAV_SIGNED_OUT;
  return (
    <nav
      aria-label={labels.label}
      className="flex flex-1 flex-wrap items-center gap-1 text-sm"
    >
      {tabs.map((n) => (
        <Link
          key={n.tab}
          href={n.href}
          className={n.tab === current ? `${TAB} ${CURRENT}` : TAB}
          aria-current={n.tab === current ? "page" : undefined}
        >
          {labels[n.tab]}
        </Link>
      ))}
      <Who who={who} current={current} labels={labels} />
    </nav>
  );
}

// The admin pages and the sign-in page aren't tabs, but their links are
// marked while you're on one.
export function navCurrent(pathname: string | null): NavCurrent {
  if (pathname !== null && /^\/admin(\/|$)/.test(pathname)) return "admin";
  if (pathname !== null && /^\/sign-in(\/|$)/.test(pathname)) return "sign-in";
  return currentTab(pathname);
}

export function SiteNav({ labels, who }: { labels: NavLabels; who: NavWho }) {
  return (
    <NavLinks current={navCurrent(usePathname())} labels={labels} who={who} />
  );
}
