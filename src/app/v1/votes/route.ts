import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { voteManySchema } from "@/lib/validate";
import { voteMany } from "@/lib/votes";

export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, voteManySchema);
  return json({
    results: await voteMany(caller, input, hashIp(clientIp(req))),
  });
});
