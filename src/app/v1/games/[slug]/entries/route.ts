import { authenticate } from "@/lib/auth";
import { createEntry, GAME_NOTICE, listEntries } from "@/lib/games";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import {
  ENTRY_TYPES,
  type EntryType,
  entrySchema,
  matchIdSchema,
  parseId,
} from "@/lib/validate";
import { findGame, gameSlug } from "../find";

type Ctx = { params: Promise<{ slug: string }> };

export const GET = route(async (req, ctx: Ctx) => {
  const game = await findGame(ctx);
  const params = new URL(req.url).searchParams;
  const rawMatch = params.get("match");
  const match =
    rawMatch === null ? undefined : matchIdSchema.safeParse(rawMatch);
  if (match && !match.success)
    throw new ApiError(400, "invalid", "match must be a match id.");
  const rawType = params.get("type");
  if (rawType !== null && !(ENTRY_TYPES as readonly string[]).includes(rawType))
    throw new ApiError(
      400,
      "invalid",
      `type must be one of ${ENTRY_TYPES.join(", ")}.`,
    );
  const rawBefore = params.get("before");
  const before = parseId(rawBefore);
  if (rawBefore !== null && before === undefined)
    throw new ApiError(400, "invalid", "before must be an entry id.");
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError(
      400,
      "invalid",
      "limit must be a whole number from 1 to 100.",
    );
  const entries = await listEntries({
    gameId: game.id,
    match: match?.data,
    type: (rawType ?? undefined) as EntryType | undefined,
    before,
    limit,
  });
  const last = entries.at(-1);
  return json({
    notice: GAME_NOTICE,
    entries,
    next_before: entries.length === limit && last ? last.id : null,
  });
});

export const POST = route(async (req, ctx: Ctx) => {
  const caller = await authenticate(req);
  assertWritable();
  const slug = await gameSlug(ctx);
  const input = await readJson(req, entrySchema);
  const { entry, created, hidden } = await createEntry(
    caller,
    slug,
    input,
    hashIp(clientIp(req)),
  );
  // A Table retrying a ref a moderator has since hidden should know it isn't
  // up; the record itself doesn't say why.
  const note = hidden
    ? {
        hidden: true,
        note: "A moderator has hidden this entry. See /moderation.",
      }
    : {};
  return json({ entry, ...note, notice: GAME_NOTICE }, created ? 201 : 200);
});
