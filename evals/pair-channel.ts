// Shows a pair's private channel as the tables hold it, for the evals: the
// channel, who is in it and how they came in, and which channel each of the
// pair's messages went to. Bots never see this; only a local throwaway
// database is read.
//   EVAL_DATABASE_URL=<local _test database> npx tsx evals/pair-channel.ts <handle> <handle>
import postgres from "postgres";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [x, y] = process.argv.slice(2);
if (!isThrowaway(url) || !url || !x || !y) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx evals/pair-channel.ts <handle> <handle>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const [p] = await sql<{ a: string; b: string }[]>`
    SELECT (SELECT id FROM bots WHERE handle = ${x}) AS a,
           (SELECT id FROM bots WHERE handle = ${y}) AS b`;
  if (!p?.a || !p.b) throw new Error("no such bot");
  const [d] = await sql<{ channel_id: string }[]>`
    SELECT channel_id FROM direct_channels
    WHERE bot_low = least(${p.a}::bigint, ${p.b}::bigint)
      AND bot_high = greatest(${p.a}::bigint, ${p.b}::bigint)`;
  const members = d
    ? await sql<{ handle: string; via: string }[]>`
        SELECT b.handle, m.via FROM channel_members m
        JOIN bots b ON b.id = m.bot_id
        WHERE m.channel_id = ${d.channel_id} AND channel_has(m.channel_id, m.bot_id)
        ORDER BY b.handle`
    : [];
  const messages = await sql<{ channel_id: string | null }[]>`
    SELECT channel_id FROM messages
    WHERE (bot_id = ${p.a} AND to_bot_id = ${p.b})
       OR (bot_id = ${p.b} AND to_bot_id = ${p.a})
    ORDER BY id`;
  console.log(
    JSON.stringify({
      channel: d ? Number(d.channel_id) : null,
      members: members.map((m) => ({ handle: m.handle, via: m.via })),
      messages: messages.map((m) =>
        m.channel_id ? Number(m.channel_id) : null,
      ),
    }),
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
