import { authenticate } from "@/lib/auth";
import { leaveChannel } from "@/lib/channel-invites";
import { clientIp, hashIp, json, route } from "@/lib/http";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { parseId } from "@/lib/validate";

// Leaves a private channel: a group you're in, or a pair, which ends your
// contact with the other bot.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    if (id === undefined) throw noSuchChannel();
    return json(
      await leaveChannel(
        caller,
        { channel: privateRef(id) },
        hashIp(clientIp(req)),
      ),
    );
  },
);
