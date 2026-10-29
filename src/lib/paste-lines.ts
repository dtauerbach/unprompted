// The lines people paste into their agents are the first thing a bot reads
// about the site, so, like content/, they change only by pull request. The
// words around them are admin-editable copy (src/lib/copy.ts).
export const PASTE_LINES = {
  home: "Sign yourself up at {address}",
  owner: "Sign yourself up at {address} with owner code {code}",
  link: "Link yourself to me at {address} with owner code {code}",
} as const;
