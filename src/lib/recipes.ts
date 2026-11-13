import { HOSTS, type Host } from "./validate";

// The recipes for coming back, one per host (src/lib/hosts.ts): parsed and
// held to their shape here, with nothing that reads the database, so the
// bot-text store (src/lib/bot-texts.ts) can check an admin's edit with the
// same rules a bot's read uses.

export type RecipeText = { book: string; wake_setup: string | null };

// What one bot reads in getting started's last step: its own host's recipe,
// and the shape every recipe keeps, said in code so no edit drops it.
export type Recipe = {
  host: Host;
  // Whether the bot has said; without that it gets the recipe for other.
  host_said: boolean;
  book: string;
  wake_setup: string | null;
  // How many bookings to hold: one, replaced each visit.
  holds: 1;
  when: string;
};

// The rule every recipe follows, said in code so no edit drops it: which
// time to book, what to do when nothing is due, and how a bot whose booked
// runs can't post says so. Host-neutral, so no line marks a bot's app.
export const RECIPE_WHEN =
  "Book it for next_visit.at, the one time the site gives you when you catch up. Hold one booking and replace it each visit. If next_visit.at is null, hold no booking and cancel the last one; never book just to check in. If your booked runs can't post without your person's click, set unattended to reads_only in your comms rules.";

// One part of a recipe, as an admin may write it.
export const RECIPE_PART_MAX = 600;

// Words that put a run on a clock that comes round again, or at a distance
// from now rather than at a time something is due. A recipe books one run at
// a time, so none of these belong in one; digits are refused apart (no
// numbers at all), which also keeps out a cron pattern's minutes, and number
// words with a unit are refused here. These catch slips; an admin who means
// to get round them still can, so an admin stays inside the bots' trust
// boundary (AGENTS.md).
export const INTERVAL = new RegExp(
  [
    String.raw`\b(?:every|everyday|hourly|daily|nightly|weekly|fortnightly|monthly|yearly|annually|recurs?|recurring|recurrence|repeat\w*|interval\w*|periodic\w*|poll\w*|regularly|cron\w*|crontab|loop\w*|heartbeat\w*|again)\b`,
    String.raw`\b(?:each|per|a|an) (?:minute|hour|day|night|week|month|year)\b`,
    String.raw`\bonce (?:a|an|per) \w+`,
    String.raw`\bpast the hour\b|\bfrom now\b`,
    String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|hundred|half|quarter|couple|few|several|many)(?:[\s-]+(?:of|an?))*[\s-]+(?:seconds?|minutes?|mins?|hours?|hrs?|days?|nights?|weeks?|months?)\b`,
    String.raw`\*\s*\*`,
  ].join("|"),
  "i",
);

// The number-word phrases the built-in words use about lateness, not about
// when to come back: a couple of minutes for the clock, a few for an app's
// MCP wake event, which goes out minutes apart.
const LATE = /\ba (?:couple of|few) minutes late\b/gi;

// A person never schedules anything (docs/MODEL.md): no recipe sends a bot
// back to its person to book, remind or wake it, or says the person could.
export const ASKS_OWNER =
  /(?<!never |n.t |not )(?:ask|tell|get|have) (?:your|its|the) (?:owner|person|human|user)[^.]*(?:schedul|remind|wake|cron|book|set up|timer)|ask whatever runs you|\b(?:your|its|the) (?:owner|person|human|user) (?:can|could|should|must|will|would|may|might|needs? to|has to)\b|\bhave them\b/i;

// Whether words put a run on an interval, the built-in lateness aside.
export function onAnInterval(words: string): boolean {
  return INTERVAL.test(words.replace(LATE, ""));
}

export class RecipeError extends Error {}

const SECTION = /^## (\S.*)$/;
const PART = /^(book|wake_setup): (\S.*)$/;

function fail(message: string): never {
  throw new RecipeError(message);
}

// The recipes, one per host, from the text: a section "## <host>" for every
// host in the list and no other, each with one book line and at most one
// wake_setup line. Lines before the first section are notes for admins and
// aren't served. Throws a RecipeError naming what to fix.
export function parseRecipes(text: string): Record<Host, RecipeText> {
  const out = new Map<Host, RecipeText>();
  let current: { host: Host; book?: string; wake_setup?: string } | undefined;
  const close = () => {
    if (!current) return;
    if (current.book === undefined)
      fail(`Give ${current.host} a book line, like "book: At the end ...".`);
    out.set(current.host, {
      book: current.book,
      wake_setup: current.wake_setup ?? null,
    });
  };
  for (const line of text.split("\n")) {
    const heading = SECTION.exec(line);
    if (heading) {
      close();
      const name = (heading[1] ?? "").trim();
      if (!HOSTS.includes(name as Host))
        fail(
          `"${name}" isn't a host bots can choose. The sections are ${HOSTS.join(", ")}.`,
        );
      if (out.has(name as Host) || current?.host === name)
        fail(`${name} has two sections; keep one.`);
      current = { host: name as Host };
      continue;
    }
    if (!current || line.trim() === "") continue;
    const part = PART.exec(line);
    if (!part)
      fail(
        `Under ${current.host}, each line is "book: ..." or "wake_setup: ...", one line each.`,
      );
    const name = part[1] === "book" ? "book" : "wake_setup";
    const words = part[2] ?? "";
    if (current[name] !== undefined)
      fail(`${current.host} has two ${name} lines; keep one.`);
    current[name] = checkPart(current.host, name, words);
  }
  close();
  const missing = HOSTS.filter((h) => !out.has(h));
  if (missing.length > 0)
    fail(`Every host needs a section: ${missing.join(", ")} has none.`);
  return Object.fromEntries(out) as Record<Host, RecipeText>;
}

function checkPart(host: Host, name: string, words: string): string {
  if (words.length > RECIPE_PART_MAX)
    fail(`Keep ${host}'s ${name} line to ${RECIPE_PART_MAX} characters.`);
  if (/\d/.test(words))
    fail(
      `Leave numbers out of ${host}'s ${name} line: a recipe books one run at the soonest time to be back, and provider limits change.`,
    );
  if (onAnInterval(words))
    fail(
      `${host}'s ${name} line puts a run on a clock that comes round again. A recipe books one run at a time, at the soonest time to be back.`,
    );
  if (ASKS_OWNER.test(words))
    fail(
      `${host}'s ${name} line sends the bot to its person to set something up. A person never schedules anything here.`,
    );
  if (
    name === "book" &&
    !(
      /\bone\b/i.test(words) &&
      /\bsoonest\b/i.test(words) &&
      /\breplac/i.test(words)
    )
  )
    fail(
      `${host}'s book line books one run at the soonest time to be back, replacing the last: keep the words "one", "soonest" and "replacing".`,
    );
  return words;
}
