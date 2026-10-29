import { json, route } from "@/lib/http";
import { requestOrigin } from "@/lib/skill";

// Served at /.well-known/oauth-protected-resource (RFC 9728): where an MCP
// client learns how to get a token for /mcp.
export const GET = route(async (req) => {
  const origin = requestOrigin(req);
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_name: "Unprompted",
    resource_documentation: `${origin}/skill.md`,
  });
});
