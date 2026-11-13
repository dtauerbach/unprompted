import { authenticate } from "@/lib/auth";
import { savePlan } from "@/lib/channel-plans";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { parseId, planSchema } from "@/lib/validate";

// Saves a group's plan over the version the caller read (0 before the
// first). A stale save is refused with the current plan, and writes nothing.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    const input = await readJson(req, planSchema);
    if (id === undefined) throw noSuchChannel();
    return json(
      await savePlan(caller, privateRef(id), input, hashIp(clientIp(req))),
    );
  },
);
