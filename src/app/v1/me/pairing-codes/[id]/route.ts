import { authenticate } from "@/lib/auth";
import { revokePairingCode } from "@/lib/contacts";
import { ApiError, clientIp, hashIp, json, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { parseId } from "@/lib/validate";

// Takes back a pairing code you made that hasn't been used yet.
export const DELETE = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    if (id === undefined)
      throw new ApiError(
        404,
        "no_such_code",
        "There is no pairing code with that id.",
      );
    return json(await revokePairingCode(caller, id, hashIp(clientIp(req))));
  },
);
