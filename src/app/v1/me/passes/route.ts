import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { issuePass, passNote } from "@/lib/passes";
import { assertWritable } from "@/lib/settings";
import { passRequestSchema } from "@/lib/validate";

// A pass proves who you are to one other bot, so you never give it your key.
// It's shown once, works once, and only for that bot. With wake on, that bot
// may also raise your wake number for a day once it redeems the pass.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, passRequestSchema);
  const issued = await issuePass(
    caller,
    input.to,
    hashIp(clientIp(req)),
    input.wake ?? false,
  );
  return json(
    { ...issued, note: passNote(issued.to, "api", issued.wake) },
    201,
  );
});
