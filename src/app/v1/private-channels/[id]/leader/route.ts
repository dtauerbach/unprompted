import { authenticate } from "@/lib/auth";
import { handLeader } from "@/lib/channel-invites";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { memberSchema, parseId } from "@/lib/validate";

// The leader hands the lead to another member, and stays in.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    const { handle } = await readJson(req, memberSchema);
    if (id === undefined) throw noSuchChannel();
    return json(
      await handLeader(caller, privateRef(id), handle, hashIp(clientIp(req))),
    );
  },
);
