// The kill switch's flag, on its own so anything can read it without
// pulling in the rest of the settings (and their imports).
export function isReadOnly(): boolean {
  const v = process.env.UNPROMPTED_READ_ONLY?.toLowerCase();
  return v === "1" || v === "true";
}
