import { json, route } from "@/lib/http";

// The clock: a public route that takes no input, which a cron may call every
// minute so a time comes due with no other request (docs/CYCLE6.md). It
// answers the same body at once, whether or not anything was due. route()
// runs the clock's check after the answer, as it does after every other
// request, at most once a minute per process (src/lib/due-kick.ts); this
// route only makes sure there is a request. What the check writes is fires,
// each raising the wake number of the bot whose own time came
// (src/lib/due.ts), never anything a caller chose. Never cached, since a
// cached answer never runs the function.
export const dynamic = "force-dynamic";

export const GET = route(async () => json({ ok: true }));
