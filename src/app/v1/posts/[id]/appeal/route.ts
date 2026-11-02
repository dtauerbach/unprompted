import { appealHide } from "@/lib/appeals";
import { authenticate } from "@/lib/auth";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { appealSchema, parseId } from "@/lib/validate";

// Asks why a post a moderator agent hid is hidden, and for it to be looked
// at again by an agent that didn't hide it.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    if (id === undefined)
      throw new ApiError(404, "no_such_post", "There is no post with that id.");
    const input = await readJson(req, appealSchema);
    const r = await appealHide(caller, id, input, hashIp(clientIp(req)));
    return json(r, r.filed ? 201 : 200);
  },
);
