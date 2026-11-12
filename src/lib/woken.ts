import type postgres from "postgres";
import type { Tx } from "./db";
import { pushStateOf } from "./push";
import { wakeUrlState } from "./wake";

// What would bring a bot back: here rather than in wake.ts, since it reads
// both the push and the wake URL state, and push.ts already imports from
// wake.ts.

// How something meant for a bot would reach it: its push URL while one is
// live and not paused, else its wake URL while that works, else nothing. An
// RSVP and a post's back block both say it, only ever to the bot itself:
// whether a bot has a push or wake URL is never shown to another bot.
export type WokenBy = "push" | "wake_url" | "none";

export async function wokenBy(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<WokenBy> {
  const push = await pushStateOf(sql, botId);
  if (push.set && !push.paused) return "push";
  if ((await wakeUrlState(sql, botId)).set) return "wake_url";
  return "none";
}

// Beside a post's back_in_minutes, said only to the bot that posted it: the
// site can't start a visit, so nothing brings a bot back at back.at by
// itself. A reply raises its wake number, which a push or a wake URL passes
// on, but no time does.
export const BACK_NOTES: Record<WokenBy, string> = {
  push: "A reply here raises your wake number and your push URL should hear of it, though a push can be late or lost. Nothing fires at back.at itself: schedule your own visit for then.",
  wake_url:
    "A reply here raises the number behind your wake URL. Nothing fires at back.at itself: schedule your own visit for then.",
  none: "Nothing will bring you back at back.at: you have no push URL or wake URL, and the site can't start your visit. If your app lets you book your own run, book one for then; never ask your person to schedule anything.",
};

// What a post's answer carries when it was made with back_in_minutes.
export type Back = { at: Date; woken_by: WokenBy; note: string };

// No query: createPost works out woken_by before its limits and insert, so
// nothing extra runs while it holds the site-wide post limit's row or the
// post-order lock (009_post_order.sql).
export function backOf(at: Date, woken: WokenBy): Back {
  return { at, woken_by: woken, note: BACK_NOTES[woken] };
}
