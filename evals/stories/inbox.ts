// How the host's tools (host-mcp.ts) tell the runner what a bot asked its
// person's app to do, in full: a visit to book with the bot's note, or a
// message to pass to another owner, which may carry a pairing code the other
// bot needs whole. The runner listens on a local port for the run's length
// and keeps what arrives in memory; host.jsonl, which people read, keeps only
// the redacted copy, so no code or key is written to disk for them.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// biome-ignore lint/suspicious/noExplicitAny: host entries are loose JSON
export type HostEntry = { kind: string; at: string; [k: string]: any };

// A booking that replaces one not yet run takes its place in the runner's
// queue for that bot: the app holds one booking per bot (host-mcp.ts).
export function dropReplaced(
  queue: { at: number; cause: string }[],
  e: HostEntry,
): void {
  if (e.kind !== "schedule_visit_granted" || !e.replaces) return;
  const from = new Date(e.at).getTime();
  for (let i = queue.length - 1; i >= 0; i--) {
    const p = queue[i];
    if (p && p.cause === "scheduled" && p.at > from) queue.splice(i, 1);
  }
}

export type HostInbox = {
  // The address to give one bot's host: entries posted there are that bot's.
  urlFor: (bot: string) => string;
  // Everything a bot's host has posted so far, in order.
  entries: (bot: string) => HostEntry[];
  close: () => Promise<void>;
};

export async function startHostInbox(): Promise<HostInbox> {
  const got = new Map<string, HostEntry[]>();
  const server = createServer((req, res) => {
    const bot = decodeURIComponent((req.url ?? "/").slice(1));
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
    });
    req.on("end", () => {
      try {
        const e = JSON.parse(body) as HostEntry;
        if (req.method !== "POST" || !bot || typeof e?.kind !== "string")
          throw new Error("bad entry");
        const list = got.get(bot) ?? [];
        list.push(e);
        got.set(bot, list);
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    urlFor: (bot) => `http://127.0.0.1:${port}/${encodeURIComponent(bot)}`,
    entries: (bot) => [...(got.get(bot) ?? [])],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// The host's side: hands one entry to the runner before the tool answers,
// so it's there by the time the visit ends. No runner (a smoke check) or
// one that's gone: the entry is only in the host log.
export async function tellRunner(
  url: string | undefined,
  entry: HostEntry,
): Promise<boolean> {
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    return r.ok;
  } catch {
    return false;
  }
}
