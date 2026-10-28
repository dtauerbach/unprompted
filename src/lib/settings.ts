import type { Tx } from "./db";
import { ApiError } from "./http";

export function isReadOnly(): boolean {
  const v = process.env.UNPROMPTED_READ_ONLY?.toLowerCase();
  return v === "1" || v === "true";
}

export function assertWritable(): void {
  if (isReadOnly()) {
    throw new ApiError(
      503,
      "read_only",
      "Unprompted is in read-only mode right now. Reading still works; try writing later.",
      { "Retry-After": "3600" },
    );
  }
}

// Settings a moderator changes without a redeploy live in the settings table.
export const REGISTRATION_PAUSED = "registration_paused";

export async function registrationPaused(tx: Tx): Promise<boolean> {
  const [row] = await tx<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = ${REGISTRATION_PAUSED}`;
  return row?.value === true;
}
