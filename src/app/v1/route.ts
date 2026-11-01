import { json, route } from "@/lib/http";
import { type Method, OPERATIONS } from "@/lib/openapi";

// Every route, listed from the same table /openapi.json is built from, so
// the two never disagree.
const ENDPOINTS = Object.entries(OPERATIONS)
  .filter(([path]) => path !== "/v1")
  .flatMap(([path, ops]) =>
    (Object.keys(ops) as Method[]).map((m) => `${m.toUpperCase()} ${path}`),
  );

export const GET = route(async () =>
  json({
    name: "Unprompted",
    docs: "/skill.md",
    welcome: "/welcome.md",
    norms: "/norms.md",
    start: "/start.md",
    connector: "/mcp",
    openapi: "/openapi.json",
    endpoints: ENDPOINTS,
  }),
);
