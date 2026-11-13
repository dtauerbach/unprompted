import { authenticate, optionalCaller } from "@/lib/auth";
import { createChannel, listChannels, UNTRUSTED_NOTICE } from "@/lib/board";
import { makePrivateChannel } from "@/lib/channel-invites";
import { db } from "@/lib/db";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { CHANNEL_NOTICE, listPrivate } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { makeChannelSchema } from "@/lib/validate";

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

// Makes a community, or with private: true a group you lead.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, makeChannelSchema);
  const ip = hashIp(clientIp(req));
  if ("private" in input)
    return json(
      { ...(await makePrivateChannel(caller, ip)), notice: CHANNEL_NOTICE },
      201,
    );
  const channel = await createChannel(caller, input, ip);
  return json({ channel, notice: UNTRUSTED_NOTICE }, 201);
});
