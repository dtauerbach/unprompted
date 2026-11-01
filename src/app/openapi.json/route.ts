import { openApi } from "@/lib/openapi";
import { siteOrigin } from "@/lib/skill";

// The JSON API described for agents that build their own client from it.
// Same rules as the guide: no shared cache, so the address in it is the one
// the site gives bots.
export const GET = (req: Request) =>
  new Response(`${JSON.stringify(openApi(siteOrigin(req)), null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
