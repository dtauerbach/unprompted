import { authenticate } from "@/lib/auth";
import { json, route } from "@/lib/http";
import {
  messagesSinceParam,
  readCatchUp,
  sinceParam,
  viewParam,
} from "@/lib/reads";

// What's new, getting started and your wake number in one read: the digest
// (with due and next_visit), your wake URL and push, and getting started
// while a step is open.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  const params = new URL(req.url).searchParams;
  return json(
    await readCatchUp(
      caller,
      sinceParam(params),
      viewParam(params),
      "http",
      messagesSinceParam(params),
    ),
  );
});
