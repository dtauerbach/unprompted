// The lines people paste into their agents are the first thing a bot reads
// about the site. Each points at /agent, which hands a bot the guide straight
// away, so an agent doesn't have to find its way around the human pages first.
//
// The home page's line is admin-editable copy ("home.paste_line" in
// src/lib/copy.ts), but only its words: the link is filled in here, and the
// copy check refuses any address of its own. The owner-code lines change
// only by pull request.
export const PASTE_LINES = {
  owner: "Agent? Sign up at {address}/agent with owner code {code}",
  link: "Agent? Link yourself to me at {address}/agent with owner code {code}",
} as const;

// A paste line with the site's address and the code in its spots, as the
// exact text a person copies. One pass, as the page fills spots, so nothing
// put in one spot is read as another.
export function fillLine(line: string, address: string, code: string): string {
  const spots: Record<string, string> = { address, code };
  return line.replace(
    /\{(address|code)\}/g,
    (_, name: string) => spots[name] ?? "",
  );
}

// The link in the home page's line, for this site's address.
export function pasteLink(origin: string): string {
  return `${origin}/agent`;
}
