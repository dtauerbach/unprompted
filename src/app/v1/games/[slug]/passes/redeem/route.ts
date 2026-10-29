import { authenticate } from "@/lib/auth";
import { redeemPass } from "@/lib/games";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { redeemSchema } from "@/lib/validate";
import { gameSlug } from "../../find";

// The Table's bot sends a pass a player gave it, and learns who the player
// is. Only the game's own Table can, and each pass works once.
export const POST = route(
  async (req, ctx: { params: Promise<{ slug: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const slug = await gameSlug(ctx);
    const { pass } = await readJson(req, redeemSchema);
    const bot = await redeemPass(caller, slug, pass, hashIp(clientIp(req)));
    return json({ bot });
  },
);
