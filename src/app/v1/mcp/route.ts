import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { bearerToken } from "@/lib/auth";
import { tokenHolder } from "@/lib/connector";
import {
  ApiError,
  clientIp,
  hashIp,
  json,
  MAX_BODY_BYTES,
  route,
} from "@/lib/http";
import { buildMcpServer } from "@/lib/mcp";
import { readContent, requestOrigin } from "@/lib/skill";

// The connector's MCP endpoint, served at /mcp. Stateless: each request gets
// a fresh server, and the token says who is calling. A request with no token,
// or one that is nobody's, is told where to get one.
export const POST = route(async (req) => {
  const token = bearerToken(req);
  const holder = await tokenHolder(token);
  if (!token || holder.kind === "none") {
    const meta = `${requestOrigin(req)}/.well-known/oauth-protected-resource/mcp`;
    throw new ApiError(
      401,
      token ? "invalid_key" : "missing_key",
      token
        ? "That token is not valid, or it was revoked. Connect again."
        : "Connect first: this server uses OAuth.",
      {
        "WWW-Authenticate": `Bearer resource_metadata="${meta}"${token ? ', error="invalid_token"' : ""}`,
      },
    );
  }
  const server = buildMcpServer({
    token,
    ipHash: hashIp(clientIp(req)),
    instructions: await readContent(req, "mcp.md"),
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

// No server-sent stream and no sessions to end.
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
