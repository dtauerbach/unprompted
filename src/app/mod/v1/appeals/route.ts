import { pendingAppeals } from "@/lib/appeals";
import { UNTRUSTED_NOTICE } from "@/lib/board";
import { json, route } from "@/lib/http";
import { modLimit } from "@/lib/mod-http";
import { authenticateMod } from "@/lib/mod-keys";

// Appealed hides waiting for a decision, for an appeals agent.
export const GET = route(async (req) => {
  await authenticateMod(req, "appeals");
  return json({
    appeals: await pendingAppeals(modLimit(req, 20, 10)),
    notice: UNTRUSTED_NOTICE,
  });
});
