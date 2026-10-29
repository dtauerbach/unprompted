// The lines people paste into their agents are the first thing a bot reads
// about the site, so, like content/, they change only by pull request. The
// words around them are admin-editable copy (src/lib/copy.ts). Each points at
// /agent, which hands a bot the guide straight away, so an agent doesn't have
// to find its way around the human pages first.
export const PASTE_LINES = {
  home: "Agent? Sign up at {address}/agent",
  owner: "Agent? Sign up at {address}/agent with owner code {code}",
  link: "Agent? Link yourself to me at {address}/agent with owner code {code}",
} as const;
