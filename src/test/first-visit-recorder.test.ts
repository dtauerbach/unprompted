import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyHash, startRecorder } from "../../evals/agents/recorder";

// The eval's recorder (evals/agents/recorder.ts): what it keeps of each
// exchange between an agent and a local site, which scoring reads.

let site: http.Server;
let siteUrl = "";
const asked: { host?: string; url?: string; auth?: string }[] = [];

beforeAll(async () => {
  site = http.createServer((req, res) => {
    asked.push({
      host: req.headers.host,
      url: req.url,
      auth: req.headers.authorization,
    });
    if (req.url?.startsWith("/cut")) {
      // An answer that promises more than it sends, then drops the line.
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      return setTimeout(() => res.socket?.resetAndDestroy(), 20);
    }
    if (req.url?.startsWith("/slow")) {
      // Answers after the agent has given up on it.
      return setTimeout(() => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end('{"saved":true}');
      }, 150);
    }
    if (req.url?.startsWith("/missing")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end('{"error":{"code":"no_such_channel"}}');
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ at: `http://${req.headers.host}`, body }));
    });
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const a = site.address();
  if (!a || typeof a === "string") throw new Error("no site");
  siteUrl = `http://127.0.0.1:${a.port}`;
});
afterAll(() => new Promise<void>((r) => site.close(() => r())));

describe("the eval's recorder", () => {
  it("records each exchange, the key only as a hash", async () => {
    const rec = await startRecorder(siteUrl);
    try {
      const got = await fetch(`${rec.origin}/v1/x?secret=abc`, {
        method: "POST",
        headers: { authorization: "Bearer key-123" },
        body: "hello",
      });
      const answer = await got.json();
      // The site was asked at the recorder's address, so it names that.
      expect(answer).toEqual({ at: rec.origin, body: "hello" });
      expect(asked.at(-1)?.auth).toBe("Bearer key-123");
      await fetch(`${rec.origin}/missing`);
      const seen = rec.take();
      expect(seen).toHaveLength(2);
      const [first, second] = seen;
      expect(first).toMatchObject({
        method: "POST",
        path: "/v1/x",
        status: 200,
        keyHash: keyHash("key-123"),
        body: JSON.stringify({ at: rec.origin, body: "hello" }),
      });
      expect(JSON.stringify(seen)).not.toMatch(/key-123|secret=abc/);
      expect(second).toMatchObject({
        method: "GET",
        path: "/missing",
        status: 404,
        keyHash: null,
      });
      expect(first?.endedAt ?? 0).toBeGreaterThanOrEqual(first?.startedAt ?? 1);
      expect(second?.startedAt ?? 0).toBeGreaterThan(first?.startedAt ?? 0);
      // Taking clears it.
      expect(rec.take()).toEqual([]);
    } finally {
      await rec.close();
    }
  });

  it("answers 502 when the site is down, and records that", async () => {
    const down = http.createServer();
    await new Promise<void>((r) => down.listen(0, "127.0.0.1", r));
    const a = down.address();
    if (!a || typeof a === "string") throw new Error("no port");
    await new Promise<void>((r) => down.close(() => r()));
    const rec = await startRecorder(`http://127.0.0.1:${a.port}`);
    try {
      const got = await fetch(`${rec.origin}/v1/me/start`);
      expect(got.status).toBe(502);
      expect(rec.take()).toMatchObject([{ path: "/v1/me/start", status: 502 }]);
    } finally {
      await rec.close();
    }
  });

  it("answers once when the site drops an answer partway", async () => {
    const rec = await startRecorder(siteUrl);
    try {
      // The site's answer and its connection both report the reset; the
      // agent gets one 502, and the recorder keeps one exchange.
      const got = await fetch(`${rec.origin}/cut`);
      expect(got.status).toBe(502);
      expect(await got.text()).toBe("site unreachable\n");
      const next = await fetch(`${rec.origin}/v1/after`);
      expect(next.status).toBe(200);
      const seen = rec.take();
      expect(seen.filter((e) => e.path === "/cut")).toEqual([
        expect.objectContaining({ status: 502 }),
      ]);
      expect(seen.at(-1)).toMatchObject({ path: "/v1/after", status: 200 });
    } finally {
      await rec.close();
    }
  });

  it("keeps a write the agent hung up on, marked undelivered", async () => {
    const rec = await startRecorder(siteUrl);
    try {
      const stop = new AbortController();
      const got = fetch(`${rec.origin}/slow`, {
        method: "POST",
        body: "{}",
        signal: stop.signal,
      }).catch(() => null);
      setTimeout(() => stop.abort(), 30);
      expect(await got).toBeNull();
      // The site still answers; the recorder keeps what it said.
      let seen: ReturnType<typeof rec.take> = [];
      for (let i = 0; i < 50 && !seen.length; i++) {
        await new Promise((r) => setTimeout(r, 20));
        seen = rec.take();
      }
      expect(seen).toEqual([
        expect.objectContaining({
          method: "POST",
          path: "/slow",
          status: 201,
          delivered: false,
        }),
      ]);
      // One it read to the end carries no mark.
      await fetch(`${rec.origin}/v1/after`).then((r) => r.text());
      expect(rec.take()[0]).not.toHaveProperty("delivered");
    } finally {
      await rec.close();
    }
  });

  it("stands only in front of a local site", async () => {
    for (const t of [
      "https://127.0.0.1:3000",
      "http://example.test",
      "http://10.0.0.1",
    ])
      await expect(startRecorder(t)).rejects.toThrow(/local site/);
  });
});
