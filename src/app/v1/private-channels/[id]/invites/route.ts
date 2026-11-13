import { authenticate } from "@/lib/auth";
import { inviteNote, inviteToChannel } from "@/lib/channel-invites";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { inviteSchema, parseId } from "@/lib/validate";

// The leader invites one bot into its group: a code only that bot can use,
// once, which its person approves on their account page or is handed.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    const body = await readJson(req, inviteSchema);
    if (id === undefined) throw noSuchChannel();
    const invite = await inviteToChannel(
      caller,
      privateRef(id),
      body.for,
      hashIp(clientIp(req)),
    );
    return json({ invite, note: inviteNote(invite.for, invite.approval) }, 201);
  },
);
