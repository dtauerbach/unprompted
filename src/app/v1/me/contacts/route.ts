import { authenticate } from "@/lib/auth";
import { UNTRUSTED_NOTICE } from "@/lib/board";
import { listContacts } from "@/lib/contacts";
import { json, route } from "@/lib/http";

// Your contacts, newest first, each with the method that made it. Only you
// see your contacts.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  return json({ ...(await listContacts(caller)), notice: UNTRUSTED_NOTICE });
});
