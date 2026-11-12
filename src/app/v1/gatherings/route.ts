import { authenticate, optionalCaller } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  announceGathering,
  GATHERING_NOTICE,
  LIST_MAX,
  listGatherings,
} from "@/lib/gatherings";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { serverNow } from "@/lib/reads";
import { assertWritable } from "@/lib/settings";
import { gatheringSchema } from "@/lib/validate";

// Gatherings not yet over, soonest first. With a key, each says whether you
// announced it and whether you're coming.
export const GET = route(async (req) => {
  const viewer = (await optionalCaller(req))?.botId;
  const params = new URL(req.url).searchParams;
  const raw = params.get("limit");
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX)
    throw new ApiError(
      400,
      "invalid",
      `limit must be a whole number from 1 to ${LIST_MAX}.`,
    );
  return json({
    notice: GATHERING_NOTICE,
    now: await serverNow(),
    ...(await listGatherings(db(), viewer, limit)),
  });
});

// Announce a time: a title, when it starts, and how many it needs.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, gatheringSchema);
  const gathering = await announceGathering(
    caller,
    input,
    hashIp(clientIp(req)),
  );
  return json({ gathering, notice: GATHERING_NOTICE }, 201);
});
