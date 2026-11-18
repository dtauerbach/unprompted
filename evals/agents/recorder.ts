// The eval's own record of what an agent asked the site and what the site
// answered: a small HTTP proxy that runs in the eval's process, outside the
// agent's sandbox, between the agent and the local site. The agent is given
// its address, and the site, which names itself by the address it was asked
// at, keeps the agent's links on it. For each request it keeps the method,
// the path without its query, the site's status and full answer, a hash of
// the key it carried (never the key), and when it began and ended by its own
// clock. Scoring reads this, never the agent's shell output, so a read counts
// only if the site really answered it. A request that goes around the
// recorder isn't seen, and counts for nothing.
import { createHash } from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";

export type Recorded = {
  method: string;
  path: string;
  status: number;
  keyHash: string | null; // sha256 of the Bearer key, if it carried one
  body: string;
  startedAt: number;
  endedAt: number;
};

export const keyHash = (key: string) =>
  createHash("sha256").update(key).digest("hex");

const REQUEST_MAX = 1024 * 1024;
const ANSWER_MAX = 8 * 1024 * 1024;
// Headers that belong to one connection, not to the request.
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
  "accept-encoding",
]);

export type Recorder = {
  origin: string;
  take: () => Recorded[]; // what it saw since the last take, oldest first
  close: () => Promise<void>;
};

export async function startRecorder(target: string): Promise<Recorder> {
  const to = new URL(target);
  if (
    to.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(to.hostname)
  )
    throw new Error("The recorder stands only in front of a local site.");
  let seen: Recorded[] = [];
  let origin = "";
  const server = http.createServer((req, res) => {
    const startedAt = performance.now();
    const auth = String(req.headers.authorization ?? "");
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(auth)?.[1];
    const entry: Recorded = {
      method: req.method ?? "GET",
      path: new URL(req.url ?? "/", "http://x").pathname,
      status: 0,
      keyHash: bearer ? keyHash(bearer) : null,
      body: "",
      startedAt,
      endedAt: startedAt,
    };
    const finish = (
      status: number,
      body: Buffer,
      headers: http.OutgoingHttpHeaders,
    ) => {
      entry.status = status;
      entry.body = body.toString("utf8");
      res.writeHead(status, { ...headers, "content-length": body.length });
      res.end(body, () => {
        entry.endedAt = performance.now();
        seen.push(entry);
      });
    };
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= REQUEST_MAX) chunks.push(c);
    });
    req.on("end", () => {
      if (size > REQUEST_MAX)
        return finish(413, Buffer.from("request too large\n"), {});
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, val] of Object.entries(req.headers))
        if (!HOP.has(k) && val !== undefined) headers[k] = val;
      // The site names itself by the host it's asked at: the recorder's.
      headers.host = new URL(origin).host;
      headers["accept-encoding"] = "identity";
      const body = Buffer.concat(chunks);
      if (body.length) headers["content-length"] = body.length;
      const up = http.request(
        {
          hostname: to.hostname.replace(/^\[|\]$/g, ""),
          port: to.port || 80,
          method: req.method,
          path: req.url,
          headers,
        },
        (answer) => {
          const got: Buffer[] = [];
          let n = 0;
          answer.on("data", (c: Buffer) => {
            n += c.length;
            if (n <= ANSWER_MAX) got.push(c);
          });
          answer.on("end", () => {
            if (n > ANSWER_MAX)
              return finish(502, Buffer.from("answer too large\n"), {});
            const back: http.OutgoingHttpHeaders = {};
            for (const [k, val] of Object.entries(answer.headers))
              if (!HOP.has(k) && val !== undefined) back[k] = val;
            finish(answer.statusCode ?? 502, Buffer.concat(got), back);
          });
          answer.on("error", () =>
            finish(502, Buffer.from("site unreachable\n"), {}),
          );
        },
      );
      up.on("error", () => finish(502, Buffer.from("site unreachable\n"), {}));
      up.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string")
    throw new Error("The recorder didn't start.");
  origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    take: () => {
      const out = [...seen].sort((a, b) => a.startedAt - b.startedAt);
      seen = [];
      return out;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
