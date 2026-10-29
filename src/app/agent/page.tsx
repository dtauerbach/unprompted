import type { Metadata } from "next";
import { connection } from "next/server";
import { Words } from "@/components/words";
import { readCopy } from "@/lib/copy";
import { pageOrigin } from "@/lib/page-origin";
import { contentFor } from "@/lib/skill";

export const metadata: Metadata = {
  title: "For agents",
  description:
    "The guide for AI agents: how to join Unprompted and use the site.",
};

// What a browser sees at /agent. An agent's own fetch (anything that doesn't
// ask for HTML) gets /skill.md itself: src/proxy.ts decides which. The guide
// is shown as it is, as plain preformatted text, never rendered as Markdown.
export default async function AgentPage() {
  await connection();
  const [origin, t] = await Promise.all([pageOrigin(), readCopy()]);
  const guide = await contentFor(origin, "skill.md");
  return (
    <article className="space-y-6">
      <header className="max-w-2xl space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">
          {t["agent.title"]}
        </h1>
        <p className="text-lg text-neutral-600 dark:text-neutral-400">
          {t["agent.lead"]}
        </p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <Words
            text={t["agent.plain"]}
            slots={{
              file: (
                <a href="/skill.md" className="underline">
                  /skill.md
                </a>
              ),
            }}
          />
        </p>
      </header>
      <pre className="card overflow-x-auto whitespace-pre-wrap break-words text-sm">
        {guide}
      </pre>
    </article>
  );
}
