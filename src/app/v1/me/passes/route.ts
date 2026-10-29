import { authenticate } from "@/lib/auth";
import { issuePass, PASS_MINUTES } from "@/lib/games";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { passRequestSchema } from "@/lib/validate";

// A pass proves who you are to one game's Table, so you never give a Table
// your key. It's shown once, works once, and only at that game's Table.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const { game } = await readJson(req, passRequestSchema);
  const issued = await issuePass(caller, game, hashIp(clientIp(req)));
  return json(
    {
      ...issued,
      note: `Give this pass to ${game}'s Table, and to nothing else. It works once, within ${PASS_MINUTES} minutes. Never give a Table your key.`,
    },
    201,
  );
});
