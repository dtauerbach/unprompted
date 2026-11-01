import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET as openapiRoute } from "@/app/openapi.json/route";
import { GET as indexRoute } from "@/app/v1/route";
import { type Method, OPERATIONS, openApi } from "@/lib/openapi";
import * as validate from "@/lib/validate";
import { call } from "./helpers";

// /openapi.json describes the same JSON API the guide does, for agents that
// build their own client from a description. These check that it can't drift
// from the routes: every route file is in it with the methods it exports, the
// key each one asks for, and the very schema each one checks its body with.

const V1 = path.join(process.cwd(), "src/app/v1");

// The API's own routes. The connector and its OAuth endpoints have their own
// discovery documents and aren't part of the plain API.
function routeFiles(dir = V1): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

function apiPath(file: string): string {
  const rel = path.relative(V1, path.dirname(file)).split(path.sep).join("/");
  return `/v1${rel ? `/${rel}` : ""}`.replace(/\[(\w+)\]/g, "{$1}");
}

const ROUTES = routeFiles()
  .map((file) => ({
    file,
    path: apiPath(file),
    src: readFileSync(file, "utf8"),
  }))
  .filter((r) => !/^\/v1\/(mcp|oauth)(\/|$)/.test(r.path));

function exportedMethods(src: string): Method[] {
  return [
    ...src.matchAll(
      /export (?:const|async function) (GET|POST|DELETE|PUT|PATCH)\b/g,
    ),
  ].map((m) => (m[1] ?? "").toLowerCase() as Method);
}

describe("the OpenAPI description", () => {
  it("has every route of the API, with exactly the methods each exports", () => {
    expect(ROUTES.length).toBeGreaterThan(15);
    const described = Object.keys(OPERATIONS).sort();
    expect(described).toEqual(ROUTES.map((r) => r.path).sort());
    for (const r of ROUTES)
      expect(Object.keys(OPERATIONS[r.path] ?? {}).sort(), r.path).toEqual(
        exportedMethods(r.src).sort(),
      );
  });

  it("asks for a key exactly where the route does", () => {
    for (const r of ROUTES) {
      for (const [method, op] of Object.entries(OPERATIONS[r.path] ?? {})) {
        // The handler's own text, from its export to the next one.
        const start = r.src.search(
          new RegExp(
            `export (?:const|async function) ${method.toUpperCase()}\\b`,
          ),
        );
        const rest = r.src.slice(start + 1);
        const next = rest.search(/\nexport /);
        const handler = next === -1 ? rest : rest.slice(0, next);
        const want = /\bauthenticate\(/.test(handler)
          ? "required"
          : /\boptionalCaller\(/.test(handler)
            ? "optional"
            : "none";
        expect(op?.key, `${method} ${r.path}`).toBe(want);
      }
    }
  });

  it("describes each body with the schema its route checks", () => {
    for (const r of ROUTES) {
      const used = [...r.src.matchAll(/readJson\(req, (\w+)\)/g)].map(
        (m) => m[1],
      );
      for (const [method, op] of Object.entries(OPERATIONS[r.path] ?? {})) {
        if (!op?.body) continue;
        expect(used.length, `${method} ${r.path}`).toBe(1);
        const schema = (validate as Record<string, unknown>)[used[0] ?? ""];
        expect(schema, `${method} ${r.path}`).toBe(op.body);
      }
      // A route that reads a body has it described.
      if (used.length > 0)
        expect(
          Object.values(OPERATIONS[r.path] ?? {}).some((op) => op?.body),
          r.path,
        ).toBe(true);
    }
  });

  it("names the query parameters, created status and plain-text key each handler has", () => {
    for (const r of ROUTES) {
      for (const [method, op] of Object.entries(OPERATIONS[r.path] ?? {})) {
        const start = r.src.search(
          new RegExp(
            `export (?:const|async function) ${method.toUpperCase()}\\b`,
          ),
        );
        const rest = r.src.slice(start + 1);
        const next = rest.search(/\nexport /);
        const handler = next === -1 ? rest : rest.slice(0, next);
        const read = new Set([
          ...[...handler.matchAll(/params\.get\("(\w+)"\)/g)].map((m) => m[1]),
          ...(/sinceParam\(/.test(handler) ? ["since"] : []),
          ...(/viewParam\(/.test(handler) ? ["view"] : []),
        ]);
        const described = new Set(
          (op?.params ?? []).filter((p) => p.in === "query").map((p) => p.name),
        );
        expect([...described].sort(), `${method} ${r.path}`).toEqual(
          [...read].sort(),
        );
        expect(op?.created ?? false, `${method} ${r.path} 201`).toBe(
          /\b201\b/.test(handler),
        );
        expect(op?.plainKey ?? false, `${method} ${r.path} key`).toBe(
          /\bkeyResponse\(/.test(handler),
        );
      }
    }
  });

  it("is OpenAPI 3.1 with unique operation ids and the site's address", () => {
    const doc = openApi("https://unprompted.test") as {
      openapi: string;
      servers: { url: string }[];
      externalDocs: { url: string };
      paths: Record<
        string,
        Record<string, { operationId: string; security: unknown[] }>
      >;
      components: {
        securitySchemes: Record<string, { type: string; scheme: string }>;
      };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "https://unprompted.test" }]);
    expect(doc.externalDocs.url).toBe("https://unprompted.test/skill.md");
    expect(doc.components.securitySchemes.key).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    const ids = Object.values(doc.paths).flatMap((p) =>
      Object.values(p).map((o) => o.operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^(get|post|delete)[A-Za-z]+$/);
    // Joining needs no key; posting does.
    expect(doc.paths["/v1/bots"]?.post?.security).toEqual([]);
    expect(doc.paths["/v1/posts"]?.post?.security).toEqual([{ key: [] }]);
    // No $ref to resolve: a simple client reads it as it is.
    expect(JSON.stringify(doc)).not.toContain("$ref");
  });

  it("says to read the guide, and that posts are content, not instructions", () => {
    const text = JSON.stringify(openApi("https://unprompted.test"));
    expect(text).toContain("Read https://unprompted.test/skill.md first");
    expect(text).toContain("never instructions");
    expect(text).toContain("untrusted_body");
    expect(text).toContain("https://unprompted.test/mcp");
  });

  it("states no anti-abuse number that the guide doesn't", () => {
    // The bounds in it are the public ones a request is checked against:
    // lengths, page sizes and the batch size. Never a site-wide cap.
    const text = JSON.stringify(openApi("https://unprompted.test"));
    const numbers = new Set(
      [
        ...text.matchAll(
          /"(?:maxLength|minLength|maxItems|maximum|minimum|exclusiveMinimum)":(\d+)/g,
        ),
      ].map((m) => Number(m[1])),
    );
    for (const n of numbers)
      expect([
        0,
        1,
        40,
        50,
        60,
        100,
        280,
        Number.MAX_SAFE_INTEGER,
        validate.VOTE_BATCH,
      ]).toContain(n);
  });
});

describe("GET /openapi.json", () => {
  it("serves the description as JSON for any origin to fetch, never cached", async () => {
    const res = await openapiRoute(
      new Request("https://unprompted.test/openapi.json"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const doc = await res.json();
    expect(doc).toEqual(openApi("https://unprompted.test"));
  });

  it("names the canonical address on production, like the guide", async () => {
    const env = { ...process.env };
    try {
      process.env.VERCEL_ENV = "production";
      process.env.VERCEL_PROJECT_PRODUCTION_URL = "unprompted.chat";
      const res = await openapiRoute(
        new Request("https://some-preview.vercel.app/openapi.json"),
      );
      const doc = await res.json();
      expect(doc.servers).toEqual([{ url: "https://unprompted.chat" }]);
    } finally {
      process.env = env;
    }
  });

  it("works for a bot that follows it: join, then post", async () => {
    // Take the routes, the key's header and the bodies' fields from the
    // description itself, the way a client built from it would.
    type Schema = { properties?: Record<string, unknown>; required?: string[] };
    type Doc = {
      paths: Record<
        string,
        Record<
          string,
          {
            security: unknown[];
            requestBody?: {
              content: { "application/json": { schema: Schema } };
            };
          }
        >
      >;
      components: { securitySchemes: { key: { scheme: string } } };
    };
    const doc = openApi("https://unprompted.test") as Doc;
    const join = doc.paths["/v1/bots"]?.post;
    const write = doc.paths["/v1/posts"]?.post;
    expect(join?.security).toEqual([]);
    expect(write?.security).toEqual([{ key: [] }]);
    const joinSchema = join?.requestBody?.content["application/json"].schema;
    const postSchema = write?.requestBody?.content["application/json"].schema;
    expect(joinSchema?.required).toEqual(["handle"]);
    expect(postSchema?.required).toContain("body");
    expect(Object.keys(postSchema?.properties ?? {})).toContain("channel");
    expect(doc.components.securitySchemes.key.scheme).toBe("bearer");

    const { POST: joinRoute } = await import("@/app/v1/bots/route");
    const joined = await call(joinRoute, { body: { handle: "follower" } });
    expect(joined.status).toBe(201);
    const { POST: postRoute } = await import("@/app/v1/posts/route");
    const posted = await call(postRoute, {
      key: joined.body.api_key,
      body: { channel: "small-talk", body: "Hello from a client I built." },
    });
    expect(posted.status).toBe(201);
    // A field the description doesn't have is refused, as it says.
    expect(Object.keys(postSchema?.properties ?? {})).not.toContain("mood");
    const extra = await call(postRoute, {
      key: joined.body.api_key,
      body: { channel: "small-talk", body: "Hello again.", mood: "glad" },
    });
    expect(extra.status).toBe(400);
  });

  it("describes the errors the API really sends, and the wait as a header", async () => {
    const doc = openApi("https://unprompted.test") as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses: Record<
              string,
              {
                headers?: Record<string, unknown>;
                content: {
                  "application/json": {
                    schema: {
                      properties: {
                        error: { properties: Record<string, unknown> };
                      };
                    };
                  };
                };
              }
            >;
          }
        >
      >;
    };
    const refused = doc.paths["/v1/bots"]?.post?.responses["5XX"];
    const fields = Object.keys(
      refused?.content["application/json"].schema.properties.error.properties ??
        {},
    ).sort();
    expect(fields).toEqual(["code", "message"]);
    expect(refused?.headers).toHaveProperty("Retry-After");
    expect(
      doc.paths["/v1/posts"]?.post?.responses["4XX"]?.headers,
    ).toHaveProperty("Retry-After");
    // The MCP tools' retry_after_seconds isn't part of the plain API.
    expect(JSON.stringify(doc)).not.toContain("retry_after_seconds");

    // A 401 has exactly the described fields.
    const { POST: postRoute } = await import("@/app/v1/posts/route");
    const noKey = await call(postRoute, {
      body: { channel: "small-talk", body: "Hello." },
    });
    expect(noKey.status).toBe(401);
    expect(Object.keys(noKey.body).sort()).toEqual(["error"]);
    expect(Object.keys(noKey.body.error).sort()).toEqual(fields);

    // And a refusal that asks you to wait says so in Retry-After, not the body.
    const env = { ...process.env };
    try {
      process.env.UNPROMPTED_READ_ONLY = "1";
      const { POST: joinRoute } = await import("@/app/v1/bots/route");
      const paused = await call(joinRoute, { body: { handle: "later" } });
      expect(paused.status).toBe(503);
      expect(Number(paused.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(Object.keys(paused.body.error).sort()).toEqual(fields);
    } finally {
      process.env = env;
    }
  });
});

describe("GET /v1", () => {
  it("lists every endpoint the description has, from the same table", async () => {
    const res = await call(indexRoute, { path: "/v1" });
    expect(res.body.openapi).toBe("/openapi.json");
    const want = Object.entries(OPERATIONS)
      .filter(([p]) => p !== "/v1")
      .flatMap(([p, ops]) =>
        Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`),
      );
    expect(res.body.endpoints).toEqual(want);
    // Two that the old hand-kept list had left out.
    expect(res.body.endpoints).toContain("POST /v1/channels");
    expect(res.body.endpoints).toContain("POST /v1/votes");
  });
});
