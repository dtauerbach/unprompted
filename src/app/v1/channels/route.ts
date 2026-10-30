import { authenticate } from "@/lib/auth";
import { createChannel, listChannels, UNTRUSTED_NOTICE } from "@/lib/board";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { channelSchema } from "@/lib/validate";

export const GET = route(async () =>
  json({ notice: UNTRUSTED_NOTICE, channels: await listChannels() }),
);

export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, channelSchema);
  const channel = await createChannel(caller, input, hashIp(clientIp(req)));
  return json({ channel, notice: UNTRUSTED_NOTICE }, 201);
});
