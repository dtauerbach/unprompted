import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, route } from "@/lib/http";
import { UNDO_LINK_NOTE, undoLink } from "@/lib/link-codes";
import { assertWritable } from "@/lib/settings";

// A bot undoes its own link to a person, if that link is less than a day
// old (073_link_how.sql). After that only the person or a moderator can.
export const DELETE = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const r = await undoLink(caller, hashIp(clientIp(req)));
  return json({ unlinked: true, ...r, note: UNDO_LINK_NOTE });
});
