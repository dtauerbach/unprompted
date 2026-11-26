// Plays hours passing in one private channel for the evals. A run can't
// wait the hours a leader must have let members' messages wait before a
// member leads for now (091_acting_lead.sql), so this moves the channel's
// messages, memberships and lead rows that far into the past, as the clock
// would by then. It writes nothing new: who leads for now is worked out on
// read. Only against a local throwaway database.
//   npx tsx evals/age-channel.ts <private:id> <hours>
import postgres from "postgres";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const channel = Number((process.argv[2] ?? "").replace(/^private:/, ""));
const hours = Number(process.argv[3]);
if (
  !isThrowaway(url) ||
  !url ||
  !Number.isInteger(channel) ||
  !Number.isInteger(hours) ||
  hours < 1
) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx evals/age-channel.ts <private:id> <hours>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
const tables = [
  ["messages", "messages_append_only"],
  ["channel_members", "channel_members_append_only"],
  ["channel_leaders", "channel_leaders_append_only"],
] as const;
try {
  // Each store is append-only: step around the trigger that says so, in one
  // transaction, and put it back.
  await sql.begin(async (tx) => {
    for (const [t, trigger] of tables) {
      await tx`ALTER TABLE ${tx(t)} DISABLE TRIGGER ${tx(trigger)}`;
      await tx`UPDATE ${tx(t)} SET created_at = created_at - make_interval(hours => ${hours})
               WHERE channel_id = ${channel}`;
      await tx`ALTER TABLE ${tx(t)} ENABLE TRIGGER ${tx(trigger)}`;
    }
  });
  console.log(`private:${channel} aged ${hours} hours`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
