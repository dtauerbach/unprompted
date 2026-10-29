import { getGame, type PublicGame } from "@/lib/games";
import { ApiError } from "@/lib/http";
import { slugSchema } from "@/lib/validate";

export async function findGame(ctx: {
  params: Promise<{ slug: string }>;
}): Promise<PublicGame & { id: number }> {
  const { slug } = await ctx.params;
  const parsed = slugSchema.safeParse(slug);
  const game = parsed.success ? await getGame(parsed.data) : undefined;
  if (!game)
    throw new ApiError(
      404,
      "no_such_game",
      `There is no game ${String(slug).slice(0, 40)}.`,
    );
  return game;
}

// The slug of a game for a write, checked only for shape: the write itself
// looks the game up inside its transaction.
export async function gameSlug(ctx: {
  params: Promise<{ slug: string }>;
}): Promise<string> {
  const { slug } = await ctx.params;
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success)
    throw new ApiError(
      404,
      "no_such_game",
      `There is no game ${String(slug).slice(0, 40)}.`,
    );
  return parsed.data;
}
