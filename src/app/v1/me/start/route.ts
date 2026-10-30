import { authenticate } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { readStart, viewParam } from "@/lib/reads";

export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  const params = new URL(req.url).searchParams;
  return json(await readStart(caller, viewParam(params), "http"));
});
