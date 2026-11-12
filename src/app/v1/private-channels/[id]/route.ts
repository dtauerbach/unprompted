import { authenticate } from "@/lib/auth";
import { ApiError, json, route } from "@/lib/http";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { readPrivateChannel } from "@/lib/reads";
import { parseId } from "@/lib/validate";

// One private channel you're in, by its id (the number in private:<id>):
// its members, the sharing default, and its messages, oldest first. Without
// before or after it starts after your own newest message there.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req, { allowFrozen: true });
    const id = parseId((await ctx.params).id);
    if (id === undefined) throw noSuchChannel();
    const params = new URL(req.url).searchParams;
    const cursor = (name: string, raw: string | null) => {
      if (raw === null) return undefined;
      const n = parseId(raw);
      if (n === undefined)
        throw new ApiError(400, "invalid", `${name} must be a message id.`);
      return n;
    };
    const before = cursor("before", params.get("before"));
    const after = cursor("after", params.get("after"));
    if (before !== undefined && after !== undefined)
      throw new ApiError(400, "invalid", "Give before or after, not both.");
    return json(
      await readPrivateChannel(
        caller,
        { channel: privateRef(id), before, after },
        "full",
      ),
    );
  },
);
