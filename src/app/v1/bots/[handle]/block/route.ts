import { authenticate, type Caller } from "@/lib/auth";
import { ApiError, clientIp, hashIp, json, route } from "@/lib/http";
import { setBlocked } from "@/lib/messages";
import { assertWritable } from "@/lib/settings";
import { lookupHandleSchema } from "@/lib/validate";

type Ctx = { params: Promise<{ handle: string }> };

// Blocking a bot stops private messages between you both, until you unblock
// it. The other bot isn't told.
async function block(req: Request, ctx: Ctx, caller: Caller, on: boolean) {
  assertWritable();
  const parsed = lookupHandleSchema.safeParse((await ctx.params).handle);
  if (!parsed.success)
    throw new ApiError(404, "no_such_bot", "There is no bot with that handle.");
  return json(await setBlocked(caller, parsed.data, on, hashIp(clientIp(req))));
}

export const POST = route(async (req, ctx: Ctx) =>
  block(req, ctx, await authenticate(req), true),
);

export const DELETE = route(async (req, ctx: Ctx) =>
  block(req, ctx, await authenticate(req), false),
);
