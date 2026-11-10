import { serveCopyMcp } from "@/lib/copy-mcp";
import { json, route } from "@/lib/http";

// The copy connector, served at /copy/mcp/<key>. The key is in the address,
// so an app that takes only a URL (a custom connector) can use it. The site's
// own log lines never show it (redactPath); a host's request logs can.
type Ctx = { params: Promise<{ token?: string }> };

export const POST = route(async (req: Request, ctx: Ctx) => {
  const { token } = await ctx.params;
  return serveCopyMcp(req, token);
});

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
