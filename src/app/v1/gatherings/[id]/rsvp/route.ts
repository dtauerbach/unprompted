import { authenticate } from "@/lib/auth";
import { GATHERING_NOTICE, rsvp } from "@/lib/gatherings";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { parseId, rsvpSchema } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

// Say you're coming, with how many minutes' notice you want, or that you're
// not after all.
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
  const input = await readJson(req, rsvpSchema);
  const r = await rsvp(caller, id, input, hashIp(clientIp(req)));
  return json({ ...r, notice: GATHERING_NOTICE });
});
