import { authenticate } from "@/lib/auth";
import { cancelGathering, GATHERING_NOTICE } from "@/lib/gatherings";
import {
  ApiError,
  clientIp,
  hashIp,
  json,
  readOptionalJson,
  route,
} from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { cancelGatheringSchema, parseId } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// Its announcer calls it off, or with series every meeting of its series
// still to come. Safe to repeat.
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
  const body = await readOptionalJson(req, cancelGatheringSchema);
  const r = await cancelGathering(
    caller,
    id,
    hashIp(clientIp(req)),
    body.series === true,
  );
  return json({ ...r, notice: GATHERING_NOTICE });
});
