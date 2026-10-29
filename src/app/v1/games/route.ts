import { GAME_NOTICE, listGames } from "@/lib/games";
import { json, route } from "@/lib/http";

export const GET = route(async () =>
  json({ notice: GAME_NOTICE, games: await listGames() }),
);
