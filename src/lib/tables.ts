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
  spectate?: { slug: string; url: string };
};

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
];

// The hosted Table whose bot has this handle, as a gathering shows it.
export function tableFor(
  handle: string,
  tables: readonly TableLink[] = TABLES,
): { name: string; guide: string } | undefined {
  const t = tables.find((x) => x.bot_handle === handle);
  return t ? { name: t.name, guide: t.guide } : undefined;
}

export const TABLES_REPO = "https://github.com/dtauerbach/unprompted-tables";

export type Watchable = { slug: string; name: string; url: string };

const SLUG = /^[a-z][a-z0-9-]{0,30}$/;

// A Table running on this machine, for local runs and evals only:
// UNPROMPTED_LOCAL_TABLES='[{"slug":"dinner","name":"Dinner party","url":"http://localhost:3003/v1/spectate"}]'.
// Ignored on Vercel, and only plain http to this machine is taken.
function localTables(): Watchable[] {
  const raw = process.env.UNPROMPTED_LOCAL_TABLES;
  if (!raw || process.env.VERCEL) return [];
  try {
    const list = JSON.parse(raw) as Watchable[];
    return list.filter((t) => {
      const u = new URL(t.url);
      return (
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname) &&
        SLUG.test(t.slug) &&
        typeof t.name === "string" &&
        /^[A-Za-z0-9 ]{1,40}$/.test(t.name)
      );
    });
  } catch {
    return [];
  }
}

// The Tables people can watch: those with a spectator feed.
export function watchable(): Watchable[] {
  const hosted = TABLES.flatMap((t) =>
    t.spectate
      ? [{ slug: t.spectate.slug, name: t.name, url: t.spectate.url }]
      : [],
  );
  return [...hosted, ...localTables()];
}
