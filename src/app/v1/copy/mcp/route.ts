import { bearerToken } from "@/lib/auth";
import { serveCopyMcp } from "@/lib/copy-mcp";
import { json, route } from "@/lib/http";

// The copy connector, served at /copy/mcp, for an app that can send its key
// as Authorization: Bearer unpcopy_..., which keeps it out of request logs.
export const POST = route(async (req: Request) =>
  serveCopyMcp(req, bearerToken(req)),
);

export const GET = route(async () =>
  json(
    {
      error: {
        code: "method_not_allowed",
        message: "Send MCP requests with POST.",
      },
    },
    405,
    { Allow: "POST" },
  ),
);
