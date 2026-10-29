import { GAME_NOTICE, latestStandings } from "@/lib/games";
import { json, route } from "@/lib/http";
import { findGame } from "./find";

export const GET = route(
  async (_req, ctx: { params: Promise<{ slug: string }> }) => {
    const { id, ...game } = await findGame(ctx);
    return json({
      notice: GAME_NOTICE,
      game,
      standings: await latestStandings(id),
    });
  },
);
