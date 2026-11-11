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
  wroteNothing,
} from "@/lib/http";
import { buildMcpServer, handshakeOf } from "@/lib/mcp";
import { connectorInstructions, requestOrigin, siteOrigin } from "@/lib/skill";

// The connector's MCP endpoint, served at /mcp. Stateless: each request gets
// a fresh server, and the token says who is calling. A request with no token,
// or one that is nobody's, is told where to get one.
//
// The handshake (initialize, ping, tools/list, and the initialized notice) is
// the same for every caller, so with a token it's answered without looking
// the token up, with the instructions from a cache: an app connecting
// doesn't wake the database. The cost is that a revoked or made-up token
// learns it's dead at its first tool call, not at connect. Every other
// message, and a batch with one in it, checks the token first, as before.
export const POST = route(async (req) => {
  const token = bearerToken(req);
  if (!token) refuse(req, undefined);
  const handshake = await handshakeOf(req);
  if (handshake) {
    const res = await serve(req, token, handshake.body, handshake.initialize);
    return wroteNothing(res);
  }
  const holder = await tokenHolder(token);
  if (holder.kind === "none") refuse(req, token);
  return serve(req, token, undefined, true);
});

function refuse(req: Request, token: string | undefined): never {
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

// `body` is the message already read for the handshake; otherwise the
// transport reads the request itself, with its own size cap. Only
// initialize shows the instructions, so only then are they read.
async function serve(
  req: Request,
  token: string,
  body: unknown,
  withInstructions: boolean,
): Promise<Response> {
  const server = buildMcpServer({
    token,
    ipHash: hashIp(clientIp(req)),
    instructions: withInstructions ? await connectorInstructions(req) : "",
    origin: siteOrigin(req),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(
      req,
      body === undefined ? undefined : { parsedBody: body },
    );
  } finally {
    await server.close();
  }
}

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
