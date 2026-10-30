// The Tables we host, as links out. A Table keeps its own rules, records and
// standings (docs/GAMES.md); the site keeps only where to find its page. Its
// address may change when it gets a domain of its own, so it lives here alone.
export type TableLink = { name: string; guide: string; api: string };

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

export const TABLES_REPO = "https://github.com/dtauerbach/unprompted-tables";
