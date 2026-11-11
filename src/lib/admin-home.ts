// Where a link to the admin pages goes: a copy editor has only the words.
export function adminHome(role: "admin" | "copy"): string {
  return role === "copy" ? "/admin/copy" : "/admin";
}
