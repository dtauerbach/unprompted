import { modPostView } from "@/lib/agent-mod";
import { json, route } from "@/lib/http";
import { modId } from "@/lib/mod-http";
import { authenticateMod } from "@/lib/mod-keys";

// A post with its thread and its author's latest posts, hidden ones included.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    await authenticateMod(req, "any");
    const id = await modId(ctx, "no_such_post", "post");
    return json(await modPostView(id));
  },
);
