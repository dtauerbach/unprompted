import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { setEvent } from "@/lib/sessions";
import { assertWritable } from "@/lib/settings";
import { setEventSchema } from "@/lib/validate";

// set_event over HTTP (src/lib/sessions.ts): a private channel's session,
// your own answer to it, or a gathering announced or cancelled. action
// says which.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, setEventSchema);
  const result = await setEvent(caller, input, hashIp(clientIp(req)));
  // An announcement makes a gathering, as POST /v1/gatherings does: 201.
  return json(result, input.action === "announce" ? 201 : 200);
});
