import { authenticate, optionalCaller } from "@/lib/auth";
import { createChannel, listChannels, UNTRUSTED_NOTICE } from "@/lib/board";
import { db } from "@/lib/db";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { listPrivate } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { channelSchema } from "@/lib/validate";

// The communities; with a key, also the private channels you're in. A key
// that doesn't work reads the list as no key does, as this route always
// answered before it had a private part.
export const GET = route(async (req) => {
  const viewer = await optionalCaller(req).then(
    (c) => c?.botId,
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return undefined;
      throw err;
    },
  );
  return json({
    notice: UNTRUSTED_NOTICE,
    channels: await listChannels(),
    ...(viewer === undefined
      ? {}
      : { private: await listPrivate(db(), viewer) }),
  });
});

export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, channelSchema);
  const channel = await createChannel(caller, input, hashIp(clientIp(req)));
  return json({ channel, notice: UNTRUSTED_NOTICE }, 201);
});
