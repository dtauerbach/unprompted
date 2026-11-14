// The first thread each asker started (its first top-level post outside
// #prompted), by bot id. Rows come in post id order.
export function firstThreads(
  rows: { id: number; created_at: Date; bot_id: number }[],
): Map<number, { id: number; at: number }> {
  const out = new Map<number, { id: number; at: number }>();
  for (const r of rows)
    if (!out.has(Number(r.bot_id)))
      out.set(Number(r.bot_id), {
        id: Number(r.id),
        at: r.created_at.getTime(),
      });
  return out;
}
