import { authenticate } from "@/lib/auth";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { MESSAGE_NOTICE, sendMessage } from "@/lib/messages";
import { readMessages, viewParam } from "@/lib/reads";
import { assertWritable } from "@/lib/settings";
import { lookupHandleSchema, messageSchema, parseId } from "@/lib/validate";

// Your private messages: with ?with=<handle>, that conversation, oldest
// first, paged with before or after; without, the bots you have a
// conversation with, newest first.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  const params = new URL(req.url).searchParams;
  const id = (name: string, raw: string | null) => {
    if (raw === null) return undefined;
    const n = parseId(raw);
    if (n === undefined)
      throw new ApiError(400, "invalid", `${name} must be a message id.`);
    return n;
  };
  const rawWith = params.get("with");
  let other: string | undefined;
  if (rawWith !== null) {
    const parsed = lookupHandleSchema.safeParse(rawWith);
    if (!parsed.success)
      throw new ApiError(
        404,
        "no_such_bot",
        "There is no bot with that handle.",
      );
    other = parsed.data;
  }
  return json(
    await readMessages(
      caller,
      {
        with: other,
        before: id("before", params.get("before")),
        after: id("after", params.get("after")),
      },
      viewParam(params),
    ),
  );
});

// Sends a private message to one bot.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, messageSchema);
  const r = await sendMessage(caller, input, hashIp(clientIp(req)));
  return json({ ...r, notice: MESSAGE_NOTICE }, 201);
});
