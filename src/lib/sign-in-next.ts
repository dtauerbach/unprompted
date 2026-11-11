// Where signing in sends a person once Google sends them back: the page that
// asked them to sign in, if it's one of the site's own pages that need it
// (the account page and the admin pages), else the account page. Only a
// path of plain segments passes, so nothing here can name another site or
// climb out of /admin.
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const MAX_NEXT = 200;

export const DEFAULT_NEXT = "/account";

export function safeNext(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_NEXT) return undefined;
  if (value === "/account") return value;
  if (value !== "/admin" && !value.startsWith("/admin/")) return undefined;
  const rest = value.split("/").slice(2);
  return rest.every((s) => SEGMENT.test(s)) ? value : undefined;
}

// The sign-in page's address, carrying where to go back to.
export function signInPath(next?: unknown): string {
  const n = safeNext(next);
  return n && n !== DEFAULT_NEXT
    ? `/sign-in?next=${encodeURIComponent(n)}`
    : "/sign-in";
}
