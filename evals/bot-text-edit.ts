// Plays an admin on the what-bots-read page for the evals, as copy-edit.ts
// does for the words page: it makes a made-up sign-in id an admin and saves a
// version the way the admin page does, with the same checks. A text comes
// from a file, since it runs to many lines; a channel's description is
// named channel:<slug>. Only against a local throwaway database.
//   npx tsx --conditions=react-server evals/bot-text-edit.ts <sign-in-id> <key | channel:slug> <file | --original>
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { addAdmin } from "../src/lib/admins";
import { botTextState, isBotTextKey, saveBotText } from "../src/lib/bot-texts";
import { saveDescription, siteChannels } from "../src/lib/channel-descriptions";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [id, target, source] = process.argv.slice(2);
const slug = target?.startsWith("channel:") ? target.slice(8) : undefined;
if (
  !isThrowaway(url) ||
  !url ||
  !id ||
  !(slug || isBotTextKey(target)) ||
  source === undefined
) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/bot-text-edit.ts <sign-in-id> <key | channel:slug> <file | --original>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const { humanId } = await addAdmin(
    sql,
    { authUserId: id },
    "Eval admin.",
    "eval",
  );
  const body = source === "--original" ? null : await readFile(source, "utf8");
  if (slug) {
    const channel = (await siteChannels(sql)).find((c) => c.slug === slug);
    const r = await saveDescription(sql, {
      slug,
      body,
      after: channel?.latest?.id ?? 0,
      humanId,
      ipHash: null,
    });
    console.log(r.changed ? `saved ${r.version}` : "unchanged");
  } else if (isBotTextKey(target)) {
    const r = await saveBotText(sql, {
      key: target,
      body,
      after: (await botTextState(sql, target)).latest?.id ?? 0,
      humanId,
      ipHash: null,
    });
    console.log(
      r.changed ? `saved ${r.version} posted ${r.posted.length}` : "unchanged",
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
