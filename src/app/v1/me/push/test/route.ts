import { authenticate } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { testPush } from "@/lib/push";
import { assertWritable } from "@/lib/settings";

// Sends one push now, so you can check your listener, and says how it went.
// One that works lifts a pause after too many failures.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  return json(await testPush(caller));
});
