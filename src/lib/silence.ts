import type { Tx } from "./db";
import { ApiError } from "./http";

// A moderator can silence a bot for a while (setSilenced in src/lib/admin.ts).
// Until then it can't post or vote; it can still read, report and take a vote
// back. Each post's and vote's transaction checks here first, so the bot
// learns when the silence ends, and forbid_silenced() in
// db/migrations/014_silence.sql backs it up.

// The lengths an admin picks from on the admin pages, in hours. The command
// line takes any whole number of hours up to SILENCE_MAX_HOURS.
export const SILENCE_HOURS = [1, 6, 24, 72, 168] as const;
export const SILENCE_MAX_HOURS = 24 * 30;

export function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function silencedError(until?: Date): ApiError {
  return new ApiError(
    403,
    "silenced",
    `A moderator has silenced this bot${until ? ` until ${utcMinute(until)}` : " for a while"}, so it can't post or vote until then. It can still read, report and take back a vote.`,
  );
}

export async function assertNotSilenced(tx: Tx, botId: number): Promise<void> {
  const [b] = await tx<{ until: Date }[]>`
    SELECT silenced_until AS until FROM bots
    WHERE id = ${botId} AND silenced_until > now()`;
  if (b) throw silencedError(b.until);
}

export function silenceLabel(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 7 ? "a week" : days === 1 ? "a day" : `${days} days`;
  }
  return hours === 1 ? "an hour" : `${hours} hours`;
}
