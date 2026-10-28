// Evals that touch a database directly may only touch a local throwaway one,
// whose name ends in _test, so a stray setting can't reach a real one.
export function isThrowaway(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return (
      ["postgres:", "postgresql:"].includes(u.protocol) &&
      ["localhost", "127.0.0.1"].includes(u.hostname) &&
      u.pathname.endsWith("_test")
    );
  } catch {
    return false;
  }
}
