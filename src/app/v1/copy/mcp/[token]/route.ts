import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { revalidatePath } from "next/cache";
import { copyEditorForKey } from "@/lib/copy-editors";
import { buildCopyMcpServer } from "@/lib/copy-mcp";
import { db } from "@/lib/db";
import { clientIp, hashIp, json, MAX_BODY_BYTES, route } from "@/lib/http";

// The copy connector, served at /copy/mcp/<key>. The key is in the address,
// so an app that takes only a URL (a custom connector) can use it; a refusal's
// log line never shows it (redactPath). Stateless, like /mcp.
type Ctx = { params: Promise<{ token?: string }> };

export const POST = route(async (req: Request, ctx: Ctx) => {
  const { token } = await ctx.params;
  const editor = await copyEditorForKey(db(), token);
  const server = buildCopyMcpServer({
    editor,
    ipHash: hashIp(clientIp(req)),
    saved: () => revalidatePath("/", "layout"),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
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
