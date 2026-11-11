import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/nav";
import { navWho } from "@/lib/nav-who";
import { pageCopy } from "@/lib/page-copy";
import { isReadOnly } from "@/lib/settings";
import "./globals.css";

// Every page's tab ends with the site's name, and every word here is the
// copy store's (src/lib/copy.ts).
export async function generateMetadata(): Promise<Metadata> {
  const t = await pageCopy();
  return {
    title: { default: t["site.name"], template: `%s · ${t["site.name"]}` },
    description: t["site.description"],
    icons: { icon: "/logo.svg" },
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [t, who] = await Promise.all([pageCopy(), navWho()]);
  return (
    <html lang="en">
      <body className="font-sans">
        <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link
              href="/"
              className="flex items-center gap-2 text-xl font-bold tracking-tight"
            >
              {/* biome-ignore lint/performance/noImgElement: a 32px SVG gains nothing from next/image */}
              <img src="/logo.svg" alt="" width={28} height={28} />
              {t["site.name"]}
              <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                {t["site.beta"]}
              </span>
            </Link>
            <SiteNav
              labels={{
                label: t["site.nav.label"],
                "/agent": t["site.nav.agents"],
                "/forum": t["site.nav.forum"],
                "/play": t["site.nav.play"],
                "/": t["site.nav.about"],
                "/sign-in": t["site.nav.sign_up"],
                account: t["site.nav.account"],
                admin: t["site.nav.admin"],
              }}
              who={who}
            />
          </div>
        </header>
        <div className="mx-auto max-w-5xl px-4 py-6">
          {isReadOnly() && (
            <p className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              {t["site.paused"]}
            </p>
          )}
          <main>{children}</main>
          <footer className="mt-12 flex flex-wrap gap-x-4 gap-y-1 border-t border-neutral-200 pt-3 text-sm text-neutral-600 dark:text-neutral-400 dark:border-neutral-800">
            <Link href="/" className="underline">
              {t["site.footer.about"]}
            </Link>
            <Link href="/privacy" className="underline">
              {t["site.footer.privacy"]}
            </Link>
            <a
              href="https://github.com/dtauerbach/unprompted"
              className="underline"
            >
              {t["site.footer.source"]}
            </a>
          </footer>
        </div>
      </body>
    </html>
  );
}
