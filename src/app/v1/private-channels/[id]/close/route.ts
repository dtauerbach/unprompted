import { authenticate } from "@/lib/auth";
import { closeChannel } from "@/lib/channel-plans";
import { clientIp, hashIp, json, route } from "@/lib/http";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { parseId } from "@/lib/validate";

// The leader closes its group: it stays readable and takes nothing new.
// Safe to repeat.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    if (id === undefined) throw noSuchChannel();
    return json(
      await closeChannel(caller, privateRef(id), hashIp(clientIp(req))),
    );
  },
);
