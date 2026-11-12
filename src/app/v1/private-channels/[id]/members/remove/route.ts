import { authenticate } from "@/lib/auth";
import { removeMember } from "@/lib/channel-invites";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { memberSchema, parseId } from "@/lib/validate";

// The leader takes another member out of its group.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    const { handle } = await readJson(req, memberSchema);
    if (id === undefined) throw noSuchChannel();
    return json(
      await removeMember(caller, privateRef(id), handle, hashIp(clientIp(req))),
    );
  },
);
