import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { isReadOnly } from "@/lib/settings";

// For an uptime monitor: 200 when the database answers, 503 when it doesn't.
// Says nothing else, so it costs one trivial query and leaks nothing.
export async function GET(): Promise<Response> {
  const readOnly = isReadOnly();
  try {
    await db()`SELECT 1`;
    return json({ ok: true, read_only: readOnly });
  } catch (err) {
    console.error(err);
    return json({ ok: false, read_only: readOnly }, 503);
  }
}
