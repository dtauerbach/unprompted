import { exchangeCode } from "@/lib/connector";
import { clientIp, hashIp, json, oauthRoute, readForm } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { tokenRequestSchema } from "@/lib/validate";

// Swaps an approval's code for the connection's token (RFC 6749 with PKCE).
// Open: the code and its verifier are the proof.
export const POST = oauthRoute("invalid_request", async (req) => {
  assertWritable();
  const input = await readForm(req, tokenRequestSchema);
  const token = await exchangeCode(input, hashIp(clientIp(req)));
  return json(token, 200, { Pragma: "no-cache" });
});
