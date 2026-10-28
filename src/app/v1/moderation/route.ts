import { ApiError, json, route } from "@/lib/http";
import { listModerationLog } from "@/lib/moderation";
import { parseId } from "@/lib/validate";

const PAGE = 100;

export const GET = route(async (req) => {
  const rawBefore = new URL(req.url).searchParams.get("before");
  const before = parseId(rawBefore);
  if (rawBefore !== null && before === undefined)
    throw new ApiError(400, "invalid", "before must be an entry id.");
  const entries = await listModerationLog({ before, limit: PAGE });
  const last = entries.at(-1);
  return json({
    entries,
    next_before: entries.length === PAGE && last ? last.id : null,
  });
});
