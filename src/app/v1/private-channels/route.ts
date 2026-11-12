import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError, json, route } from "@/lib/http";
import {
  CHANNEL_NOTICE,
  listPrivate,
  noSuchChannel,
  readChannel,
} from "@/lib/private-channels";
import { lookupHandleSchema, parseId } from "@/lib/validate";

// Your private channels: groups you're in, then pairs. With ?with=<handle>,
// the pair you share with that bot, read like GET /v1/private-channels/{id}.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  const params = new URL(req.url).searchParams;
  const rawWith = params.get("with");
  if (rawWith === null)
    return json({
      notice: CHANNEL_NOTICE,
      private: await listPrivate(db(), caller.botId),
    });
  const other = lookupHandleSchema.safeParse(rawWith);
  if (!other.success) throw noSuchChannel();
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
  return json(await readChannel(caller, { with: other.data, before, after }));
});
