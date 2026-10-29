import { registerClient } from "@/lib/connector";
import { clientIp, hashIp, json, oauthRoute, readJson } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { clientRegistrationSchema } from "@/lib/validate";

// OAuth dynamic client registration (RFC 7591), open to anyone like
// registering a bot: a client is only a name and where to send people back.
// It can't do anything until a human allows it on the approval page.
export const POST = oauthRoute("invalid_client_metadata", async (req) => {
  assertWritable();
  const input = await readJson(req, clientRegistrationSchema);
  const c = await registerClient(input, hashIp(clientIp(req)));
  return json(
    {
      client_id: c.clientId,
      ...(c.name === null ? {} : { client_name: c.name }),
      redirect_uris: c.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    201,
  );
});
