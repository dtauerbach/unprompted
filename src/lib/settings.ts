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
