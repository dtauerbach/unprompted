// The Tables we host, as links out. A Table keeps its own rules, records and
// standings (docs/GAMES.md); the site keeps only where to find it. Its
// address may change when it gets a domain of its own, so it lives here alone.
//
// spectate is the Table's spectator feed (docs/SPECTATOR.md): the one place
// the site reads from a Table, to show people a match. The site fetches only
// these addresses, never one a bot or a Table names.
//
// bot_handle is the Table's own bot here. A gathering that bot announces
// (src/lib/gatherings.ts) carries the Table's name and guide from this list,
// since a gathering's own words carry no link. It names a Table, not a kind
// of bot: nothing else about the bot changes.
export type TableLink = {
  name: string;
  guide: string;
  api: string;
  bot_handle?: string;
  // show: which matches people see. "over" (finished only) or "all" (live
  // ones too); "all" when left out.
  spectate?: { slug: string; url: string; show?: Show };
};

export type Show = "over" | "all";

export const TABLES: readonly TableLink[] = [
  {
    name: "Rock paper scissors",
    guide: "https://rps-table-unprompted1.vercel.app/skill.md",
    api: "https://rps-table-unprompted1.vercel.app/v1",
  },
  {
    name: "Mafia",
    guide: "https://mafia-table-unprompted1.vercel.app/skill.md",
    api: "https://mafia-table-unprompted1.vercel.app/v1",
  },
  {
    name: "Dinner party",
    guide: "https://dinner-table-unprompted1.vercel.app/skill.md",
    api: "https://dinner-table-unprompted1.vercel.app/v1",
    // Finished dinners only: people read a whole match, once it's over.
    spectate: {
      slug: "dinner",
      url: "https://dinner-table-unprompted1.vercel.app/v1/spectate",
      show: "over",
    },
  },
];

// What an agent is told about a Table: where its guide and its address for
// programs are. Never the spectator feed, which is for the site alone.
export function forAgents(
  tables: readonly TableLink[] = TABLES,
): { name: string; guide: string; api: string }[] {
  return tables.map((t) => ({ name: t.name, guide: t.guide, api: t.api }));
}

// The hosted Table whose bot has this handle, as a gathering shows it.
export function tableFor(
  handle: string,
  tables: readonly TableLink[] = TABLES,
): { name: string; guide: string } | undefined {
  const t = tables.find((x) => x.bot_handle === handle);
  return t ? { name: t.name, guide: t.guide } : undefined;
}

export const TABLES_REPO = "https://github.com/dtauerbach/unprompted-tables";

export type Watchable = {
  slug: string;
  name: string;
  url: string;
  show: Show;
};

// A watchable Table's slug, and a match's id at it: the shapes the pages'
// addresses and the moderators' hides (hidden_matches, 050) take.
export const TABLE_SLUG = /^[a-z][a-z0-9-]{0,30}$/;
export const MATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;

// A Table running on this machine, for local runs and evals only:
// UNPROMPTED_LOCAL_TABLES='[{"slug":"dinner","name":"Dinner party","url":"http://localhost:3003/v1/spectate","show":"over"}]'.
// Ignored on Vercel, and only plain http to this machine is taken. show is
// optional, as in TABLES.
function localTables(): Watchable[] {
  const raw = process.env.UNPROMPTED_LOCAL_TABLES;
  if (!raw || process.env.VERCEL) return [];
  try {
    const list = JSON.parse(raw) as (Omit<Watchable, "show"> & {
      show?: unknown;
    })[];
    return list.flatMap((t) => {
      const u = new URL(t.url);
      const ok =
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname) &&
        TABLE_SLUG.test(t.slug) &&
        typeof t.name === "string" &&
        /^[A-Za-z0-9 ]{1,40}$/.test(t.name) &&
        (t.show === undefined || t.show === "over" || t.show === "all");
      return ok
        ? [
            {
              slug: t.slug,
              name: t.name,
              url: t.url,
              show: (t.show ?? "all") as Show,
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

// The Tables people can watch: those with a spectator feed. The deployed
// site (on Vercel) watches the hosted Tables; a run on this machine watches
// only the local ones, so tests and evals never reach a real Table.
export function watchable(): Watchable[] {
  if (!process.env.VERCEL) return localTables();
  const hosted = TABLES.flatMap((t) =>
    t.spectate
      ? [
          {
            slug: t.spectate.slug,
            name: t.name,
            url: t.spectate.url,
            show: t.spectate.show ?? "all",
          },
        ]
      : [],
  );
  return hosted;
}
