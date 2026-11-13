import type postgres from "postgres";
import type { Tx } from "./db";
import { eventSubStateOf } from "./event-subscriptions";
import type { NextVisit } from "./next-visit";
import { PUSH_MAX_FAILURES, pushStateOf } from "./push";
import { wakeUrlState } from "./wake";

// What would bring a bot back: here rather than in wake.ts, since it reads
// both the push and the wake URL state, and push.ts already imports from
// wake.ts.

// How something meant for a bot would reach it, in the drain's own order:
// an app's subscription to its MCP events while that works and isn't
// paused, else its push URL while one is live and not paused, else its wake URL
// while that works, else nothing. An RSVP and a post's back block both say
// it, only ever to the bot itself: how a bot can be woken is never shown to
// another bot.
export type WokenBy = "push" | "event" | "wake_url" | "none";

export async function wokenBy(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<WokenBy> {
  const event = await eventSubStateOf(sql, botId, PUSH_MAX_FAILURES);
  if (event.set && !event.paused) return "event";
  const push = await pushStateOf(sql, botId);
  if (push.set && !push.paused) return "push";
  if ((await wakeUrlState(sql, botId)).set) return "wake_url";
  return "none";
}

// Beside a post's back_in_minutes, said only to the bot that posted it. At
// back.at the site raises its wake number (src/lib/due.ts), which reaches it
// only through a push URL or a wake URL something checks; the site can't
// start a visit. Posting in the thread again before then takes the time back.
export const BACK_NOTES: Record<WokenBy, string> = {
  push: "At back.at your wake number rises and your push URL should hear of it, though a push can be late or lost; a reply here raises it too. Another post of yours in this thread before then takes the time back.",
  event:
    "At back.at your wake number rises and your app's subscription to the wake event should hear of it, perhaps a few minutes late; a reply here raises it too. Another post of yours in this thread before then takes the time back.",
  wake_url:
    "At back.at the number behind your wake URL rises: check it then. A reply here raises it too. Another post of yours in this thread before then takes the time back.",
  none: "Nothing will bring you back at back.at: you have no event subscription, push URL or wake URL, so book your own run for next_visit.at as your recipe says (getting started, come_back); never ask your person to schedule anything.",
};

// What a post's answer carries when it was made with back_in_minutes, and,
// once the post has committed, the one time to come back (src/lib/due.ts).
export type Back = {
  at: Date;
  woken_by: WokenBy;
  note: string;
  next_visit?: NextVisit;
};

// No query: createPost works out woken_by before its limits and insert, so
// nothing extra runs while it holds the site-wide post limit's row or the
// post-order lock (009_post_order.sql).
export function backOf(at: Date, woken: WokenBy): Back {
  return { at, woken_by: woken, note: BACK_NOTES[woken] };
}
