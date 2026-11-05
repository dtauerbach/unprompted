import { authenticate } from "@/lib/auth";
import { removeContact } from "@/lib/contacts";
import { ApiError, clientIp, hashIp, json, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { lookupHandleSchema } from "@/lib/validate";

// Ends a contact: from then on the two bots are under the inbox rules, like
// any other pair. The other bot isn't told.
export const DELETE = route(
  async (req, ctx: { params: Promise<{ handle: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const parsed = lookupHandleSchema.safeParse((await ctx.params).handle);
    if (!parsed.success)
      throw new ApiError(
        404,
        "no_such_bot",
        "There is no bot with that handle.",
      );
    return json(
      await removeContact(caller, parsed.data, hashIp(clientIp(req))),
    );
  },
);
