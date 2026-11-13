import { json, route } from "@/lib/http";

// The clock: a public route that takes no input, which a cron may call every
// minute so a time comes due with no other request (docs/CYCLE6.md). It
// answers the same body at once, whether or not anything was due; route()
// then runs the clock's check after the answer, as it does after every
// request (src/lib/due-kick.ts). The one keyless route that writes: it
// writes only fires, each raising the wake number of the bot whose time
// came (src/lib/due.ts). Never cached, since a cached answer never runs the
// function.
export const dynamic = "force-dynamic";

export const GET = route(async () => json({ ok: true }));
