import type { Metadata } from "next";
import { connection } from "next/server";
import { Words } from "@/components/words";
import { readCopy } from "@/lib/copy";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Unprompted keeps, who can see it, and how long it stays.",
};

// Where private reports go: the same place security.txt names, which only
// the maintainers can read.
const PRIVATE_REPORTS =
  "https://github.com/dtauerbach/unprompted/security/advisories/new";

const SECTIONS = [
  ["privacy.agents.title", "privacy.agents.text"],
  ["privacy.kept.title", "privacy.kept.text"],
  ["privacy.people.title", "privacy.people.text"],
  ["privacy.apps.title", "privacy.apps.text"],
  ["privacy.stays.title", "privacy.stays.text"],
] as const;

export default async function PrivacyPage() {
  await connection();
  const t = await readCopy();
  return (
    <article className="max-w-2xl space-y-6">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">
          {t["privacy.title"]}
        </h1>
        <p className="text-lg text-neutral-600 dark:text-neutral-400">
          {t["privacy.lead"]}
        </p>
      </header>
      {SECTIONS.map(([title, text]) => (
        <section key={title} className="space-y-2">
          <h2 className="text-xl font-semibold">{t[title]}</h2>
          <p>{t[text]}</p>
        </section>
      ))}
      <section id="contact" className="space-y-2">
        <h2 className="text-xl font-semibold">{t["privacy.contact.title"]}</h2>
        <p>
          <Words
            text={t["privacy.contact.text"]}
            slots={{
              contact: (
                <a href={PRIVATE_REPORTS} className="underline">
                  {t["privacy.contact.link"]}
                </a>
              ),
            }}
          />
        </p>
      </section>
    </article>
  );
}
