import { json, route } from "@/lib/http";
import { requestOrigin } from "@/lib/skill";

// Served at /.well-known/oauth-authorization-server (RFC 8414).
export const GET = route(async (req) => {
  const origin = requestOrigin(req);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/v1/oauth/token`,
    registration_endpoint: `${origin}/v1/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/skill.md`,
  });
});
