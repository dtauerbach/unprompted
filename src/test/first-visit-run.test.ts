import { spawnSync } from "node:child_process";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  keyHash,
  type Recorder,
  startRecorder,
} from "../../evals/agents/recorder";
import { run } from "../../evals/agents/run";

// The first-visit eval runs its agent while the recorder, in the same
// process, answers the agent's requests (evals/agents/run.ts). With no
// model: a stand-in child makes a request through the recorder while the
// eval waits on it, as the agent does.

let site: http.Server;
let rec: Recorder;

beforeAll(async () => {
  site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`answered ${req.url}`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const a = site.address();
  if (!a || typeof a === "string") throw new Error("no site");
  rec = await startRecorder(`http://127.0.0.1:${a.port}`);
});
afterAll(async () => {
  await rec.close();
  await new Promise<void>((r) => site.close(() => r()));
});

// A child that asks the recorder once and prints what it got, giving up
// after a while so a stalled request shows as "stalled".
const child = (url: string) => [
  "-e",
  `fetch(${JSON.stringify(url)}, { headers: { authorization: "Bearer child-key" }, signal: AbortSignal.timeout(2000) })
     .then(async (r) => console.log(r.status, await r.text()))
     .catch(() => console.log("stalled"))`,
];
const env: Record<string, string> = { PATH: process.env.PATH ?? "" };

describe("running the agent beside the recorder", () => {
  it("serves the child's request while the eval waits, and records it", async () => {
    rec.take();
    const got = await run(
      process.execPath,
      child(`${rec.origin}/v1/me/start`),
      {
        env,
        timeoutMs: 20_000,
        maxBytes: 1024 * 1024,
      },
    );
    expect(got.error).toBeUndefined();
    expect(got.status).toBe(0);
    expect(got.stdout.trim()).toBe("200 answered /v1/me/start");
    expect(rec.take()).toMatchObject([
      {
        method: "GET",
        path: "/v1/me/start",
        status: 200,
        keyHash: keyHash("child-key"),
        body: "answered /v1/me/start",
      },
    ]);
  });

  it("would stall under spawnSync, which is why the eval doesn't use it", () => {
    rec.take();
    const got = spawnSync(process.execPath, child(`${rec.origin}/v1/x`), {
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(got.stdout.trim()).toBe("stalled");
  });

  it("stops a child that runs past its deadline", async () => {
    const t0 = Date.now();
    const got = await run(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        env,
        timeoutMs: 500,
        maxBytes: 1024,
      },
    );
    expect(got.error?.code).toBe("ETIMEDOUT");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("stops a child that prints past its cap, keeping what fit", async () => {
    const got = await run(
      process.execPath,
      ["-e", "setInterval(() => process.stdout.write('x'.repeat(4096)), 1)"],
      { env, timeoutMs: 20_000, maxBytes: 10_000 },
    );
    expect(got.error?.code).toBe("ENOBUFS");
    expect(got.stdout.length).toBeLessThanOrEqual(10_000);
  });

  it("says when a child can't start", async () => {
    const got = await run("/no/such/program", [], {
      env,
      timeoutMs: 1_000,
      maxBytes: 1024,
    });
    expect(got.error?.code).toBe("ENOENT");
  });
});
