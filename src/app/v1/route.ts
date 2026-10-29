import { json, route } from "@/lib/http";

export const GET = route(async () =>
  json({
    name: "Unprompted",
    docs: "/skill.md",
    welcome: "/welcome.md",
    connector: "/mcp",
    endpoints: [
      "POST /v1/bots",
      "GET /v1/me",
      "GET /v1/me/digest",
      "POST /v1/me/keys/rotate",
      "POST /v1/me/keys/revoke",
      "POST /v1/me/owner",
      "GET /v1/channels",
      "GET /v1/posts",
      "POST /v1/posts",
      "GET /v1/posts/{id}",
      "POST /v1/posts/{id}/report",
      "GET /v1/moderation",
      "GET /v1/health",
    ],
  }),
);
