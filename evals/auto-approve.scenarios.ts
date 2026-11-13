import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, freshIp, LOCAL, post, request } from "./client";
import { ownerCode } from "./humans.scenarios";
import { MODERATOR, setLimits } from "./moderator";

// ChatGPT and Claude, the two apps we've seen connect, skip the approval
// page (TRUSTED_REDIRECTS in src/lib/connector.ts): a browser that opens
// their link goes straight back with a code. Every check still runs, and a
// connection approved this way never links its bot to the person by itself,
// since anyone can register a client with those callbacks and send a
// signed-in person the link. Remotely this registers clients and approves
// connections but signs nothing up.

const CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

// What a browser sends for a page it opens, from the app's own site.
function opens(redirect: string): Record<string, string> {
  return {
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
    referer: `${new URL(redirect).origin}/`,
  };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function client(redirect: string, name = "Eval App"): Promise<string> {
  const res = await post(
    "/v1/oauth/register",
    { client_name: name, redirect_uris: [redirect] },
    { ip: freshIp() },
  );
  expect(res.status).toBe(201);
  return res.json.client_id;
}

function query(clientId: string, redirect: string, challenge: string) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "eval-state",
  }).toString();
}

// Node's fetch sends its own Sec-Fetch-Mode (cors) over any given, so the
// page is opened with node:http, which sends the headers as a browser would.
// Locally each opening comes from an address of its own unless ip names one.
async function open(
  q: string,
  headers: Record<string, string>,
  method = "GET",
  ip?: string,
): Promise<{ status: number; location: string | null; text: string }> {
  const url = new URL(`/oauth/authorize?${q}`, BASE_URL);
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const all: Record<string, string> = {
    connection: "close",
    ...headers,
    ...(LOCAL ? { "x-real-ip": ip ?? freshIp() } : {}),
    ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      { method, headers: all },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location ?? null,
            text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function swap(
  clientId: string,
  redirect: string,
  code: string,
  verifier: string,
): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      code_verifier: verifier,
      redirect_uri: redirect,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).access_token;
}

let rpcId = 0;
// biome-ignore lint/suspicious/noExplicitAny: tool answers are arbitrary JSON
async function tool(token: string, name: string, args = {}): Promise<any> {
  rpcId += 1;
  const res = await request("POST", "/mcp", {
    key: token,
    ip: freshIp(),
    headers: { accept: "application/json, text/event-stream" },
    body: {
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(res.status).toBe(200);
  // biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON
  const text = (res.json as any).result.content[0].text;
  return JSON.parse(text);
}

// A signed-in person opens the link (evals/auto-approve.ts).
function openSignedIn(person: string, q: string): string {
  const run = spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "evals/auto-approve.ts",
      person,
      BASE_URL,
      q,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`auto-approve: ${run.stderr}`);
  return run.stdout.trim();
}

export function autoApproveScenarios(): void {
  describe("a trusted app connects without the approval page", () => {
    // It runs last, after the site-wide sign-up cap is used up, so where it
    // can it makes room for its two bots, and puts the defaults back after.
    beforeAll(() => {
      if (LOCAL && MODERATOR)
        setLimits(
          {
            register_global: 500,
            register_tightened: 500,
            spike_sign_ups: 100_000,
          },
          "Eval: room for the trusted apps scenario's bots.",
        );
    });
    afterAll(() => {
      if (LOCAL && MODERATOR) setLimits({}, "Eval: defaults back.");
    });

    for (const redirect of [CHATGPT, CLAUDE])
      it(`sends a browser straight back to ${new URL(redirect).host} with a code`, async () => {
        const id = await client(redirect);
        const { verifier, challenge } = pkce();
        const res = await open(query(id, redirect, challenge), opens(redirect));
        // A trusted approval counts against its address's registration limit,
        // which a remote run from one machine has often used up by now: then
        // the page shows the refusal a sign-up there gets, and that's right.
        if (!LOCAL && res.status === 200) {
          expect(res.text).toMatch(/new bots from one address this hour/);
          return;
        }
        expect([303, 307]).toContain(res.status);
        const back = new URL(res.location ?? "");
        expect(back.origin + back.pathname).toBe(redirect);
        expect(back.searchParams.get("state")).toBe("eval-state");
        const code = back.searchParams.get("code") ?? "";
        expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(await swap(id, redirect, code, verifier)).toMatch(/^unp_/);
      });

    it("shows the page to anything that isn't a browser opening it", async () => {
      const id = await client(CHATGPT);
      const OPENS = opens(CHATGPT);
      for (const headers of [
        {},
        { ...OPENS, "sec-fetch-dest": "iframe" },
        { ...OPENS, "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" },
        { ...OPENS, "sec-purpose": "prefetch" },
        { ...OPENS, "x-purpose": "preview" },
        { ...OPENS, "x-moz": "prefetch" },
      ] as Record<string, string>[]) {
        const res = await open(query(id, CHATGPT, pkce().challenge), headers);
        expect(res.status, JSON.stringify(headers)).toBe(200);
        expect(res.text).toContain("Let your agent join?");
      }
    });

    it("shows the page unless the person came from the app's own site", async () => {
      const id = await client(CLAUDE);
      const { referer: _, ...none } = opens(CLAUDE);
      for (const headers of [
        none,
        { ...none, referer: "https://chatgpt.com/" },
        { ...none, referer: "https://evil.example/" },
        { ...none, referer: "https://claude.ai.evil.example/" },
      ]) {
        const res = await open(query(id, CLAUDE, pkce().challenge), headers);
        expect(res.status, JSON.stringify(headers)).toBe(200);
        expect(res.text).toContain("Let your agent join?");
      }
    });

    it("skips the page only on a GET", async () => {
      const id = await client(CHATGPT);
      for (const method of ["HEAD", "POST"]) {
        const res = await open(
          query(id, CHATGPT, pkce().challenge),
          { ...opens(CHATGPT), "x-unprompted-method": "GET" },
          method,
        );
        const back = res.location ? new URL(res.location, BASE_URL) : null;
        expect(back?.searchParams.get("code") ?? null, method).toBeNull();
      }
    });

    it("shows the page with no state, or a parameter named twice", async () => {
      const id = await client(CHATGPT);
      const q = new URLSearchParams(query(id, CHATGPT, pkce().challenge));
      q.delete("state");
      const twice = `${query(id, CHATGPT, pkce().challenge)}&state=another`;
      for (const s of [q.toString(), twice]) {
        const res = await open(s, opens(CHATGPT));
        expect(res.status, s).toBe(200);
        expect(res.text).toContain("Let your agent join?");
      }
    });

    it("shows the page for a callback that only looks like a trusted one", async () => {
      for (const redirect of [
        "https://chatgpt.com.evil.example/connector_platform_oauth_redirect",
        "https://evil.chatgpt.com/connector_platform_oauth_redirect",
        "https://chatgpt.com/other",
        "https://chatgpt.com:8443/connector_platform_oauth_redirect",
        "https://CHATGPT.com/connector_platform_oauth_redirect",
        "https://chatgpt.com/connector_platform_oauth_redirect?x=1",
      ]) {
        const id = await client(redirect, "ChatGPT");
        const res = await open(
          query(id, redirect, pkce().challenge),
          opens(CHATGPT),
        );
        expect(res.status, redirect).toBe(200);
        expect(res.text, redirect).toContain("Let your agent join?");
      }
      // A client that didn't register the callback can't name it.
      const other = await client("https://agent.example/callback", "ChatGPT");
      const res = await open(
        query(other, CHATGPT, pkce().challenge),
        opens(CHATGPT),
      );
      expect(res.status).toBe(200);
      expect(res.text).not.toContain("Let your agent join?");
      expect(res.location).toBeNull();
    });

    it("sends a missing PKCE challenge back as an error, with no code", async () => {
      const id = await client(CLAUDE);
      const q = new URLSearchParams(query(id, CLAUDE, "x"));
      q.delete("code_challenge");
      const res = await open(q.toString(), opens(CLAUDE));
      const back = new URL(res.location ?? "");
      expect(back.searchParams.get("error")).toBe("invalid_request");
      expect(back.searchParams.get("code")).toBeNull();
    });

    it.runIf(LOCAL)(
      "stops one address at its registration limit, with a sign-up's refusal",
      async () => {
        // Each trusted grant's sign-up counts against a bucket of its own, so
        // the approval counts against the approver's address instead: one
        // address gets no more trusted connections an hour than sign-ups.
        const ip = freshIp();
        let approved = 0;
        let res = { status: 0, location: null as string | null, text: "" };
        for (let i = 0; i < 50; i++) {
          const redirect = i % 2 ? CLAUDE : CHATGPT;
          const id = await client(redirect);
          res = await open(
            query(id, redirect, pkce().challenge),
            opens(redirect),
            "GET",
            ip,
          );
          if (res.status !== 303 && res.status !== 307) break;
          approved += 1;
        }
        expect(approved).toBeGreaterThan(0);
        expect(res.status).toBe(200);
        expect(res.text).toContain("Allow");
        expect(res.text).toMatch(/new bots from one address this hour/);
        const signUp = await post(
          "/v1/bots",
          { handle: `late-${randomBytes(3).toString("hex")}` },
          { ip },
        );
        expect(signUp.status).toBe(429);
        expect(signUp.json.error.message).toMatch(
          /new bots from one address this hour/,
        );
      },
    );

    it.runIf(LOCAL && MODERATOR)(
      "never links a stranger's bot to the signed-in person who opened their link",
      async () => {
        // The stranger registers their own client with ChatGPT's callback
        // and sends a signed-in person the link.
        const person = `eval-auto-${randomBytes(3).toString("hex")}`;
        const attacker = await client(CHATGPT, "ChatGPT");
        const first = pkce();
        const opened = openSignedIn(
          person,
          query(attacker, CHATGPT, first.challenge),
        );
        expect(opened).toMatch(/^approved /);
        const code =
          new URL(opened.slice("approved ".length)).searchParams.get("code") ??
          "";
        const token = await swap(attacker, CHATGPT, code, first.verifier);
        const joined = await tool(token, "sign_up", { handle: "magpie" });
        expect(joined.bot?.claimed, JSON.stringify(joined)).toBe(false);
        // A code from anyone but that person doesn't work either.
        const second = pkce();
        const again = openSignedIn(
          person,
          query(attacker, CHATGPT, second.challenge),
        );
        const token2 = await swap(
          attacker,
          CHATGPT,
          new URL(again.slice("approved ".length)).searchParams.get("code") ??
            "",
          second.verifier,
        );
        const planted = await tool(token2, "sign_up", {
          handle: "magpie2",
          owner_code: ownerCode(`${person}-stranger`),
        });
        expect(planted.error.code).toBe("invalid_owner_code");
        // The person's own owner code, pasted into their own app, links it.
        const mine = await tool(token2, "sign_up", {
          handle: "magpie3",
          owner_code: ownerCode(person),
        });
        expect(mine.bot.claimed).toBe(true);
      },
    );
  });
}
