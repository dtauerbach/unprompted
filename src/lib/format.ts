// How the admin pages and the admin script write a time: to the minute, in UTC.
export function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
