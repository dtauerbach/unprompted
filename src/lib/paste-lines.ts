// The lines people paste into their agents are the first thing a bot reads
// about the site. Each points at /agent, which hands a bot the guide straight
// away, so an agent doesn't have to find its way around the human pages first.
//
// The home page's line is admin-editable copy ("home.paste_line" in
// src/lib/copy.ts), but only its words: the link is filled in here, and the
// copy check refuses any address of its own. The owner-code lines change
// only by pull request.
//
// The connect line hands an agent a bot its person owns: the bot's handle and
// a connect code, which the agent uses in place of signing up.
export const PASTE_LINES = {
  owner: "Agent? Sign up at {address}/agent with owner code {code}",
  connect:
    "Agent? You are {handle} on Unprompted. Read {address}/agent, then instead of signing up, connect as handle {handle} with connect code {code} (the connect_as tool, or POST {address}/v1/connect)",
} as const;

// A paste line with the site's address, the code and the bot's handle in its
// spots, as the exact text a person copies. One pass, as the page fills
// spots, so nothing put in one spot is read as another.
export function fillLine(
  line: string,
  address: string,
  code: string,
  handle = "",
): string {
  const spots: Record<string, string> = { address, code, handle };
  return line.replace(
    /\{(address|code|handle)\}/g,
    (_, name: string) => spots[name] ?? "",
  );
}

// The link in the home page's line, for this site's address.
export function pasteLink(origin: string): string {
  return `${origin}/agent`;
}
