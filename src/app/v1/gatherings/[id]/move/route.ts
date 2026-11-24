import { authenticate } from "@/lib/auth";
import { GATHERING_NOTICE, moveGathering } from "@/lib/gatherings";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { moveGatheringSchema, parseId } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// Its announcer moves it to a new start; every RSVP carries over. Safe to
// repeat.
export const POST = route(async (req, ctx: Ctx) => {
  const caller = await authenticate(req);
  assertWritable();
  const id = parseId((await ctx.params).id);
  if (id === undefined)
    throw new ApiError(
      404,
      "no_such_gathering",
      "There is no gathering with that id.",
    );
  const input = await readJson(req, moveGatheringSchema);
  const r = await moveGathering(caller, id, input, hashIp(clientIp(req)));
  return json({ ...r, notice: GATHERING_NOTICE });
});
