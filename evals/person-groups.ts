// Plays a signed-in person on the account page's groups: starts a group of
// their own bots, puts one in or takes one out, picks a leader, or lists
// their groups as the page shows them. Google sign-in can't run in a
// script, so this acts for a made-up sign-in id. Prints JSON: the answer,
// or the refusal's code and words. Only against a local throwaway database.
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> start <leader|-> <handle>...
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> add|take-out|lead <private:id> <handle>
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> list
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> release <handle>
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> peek <private:id>
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> write <private:id> wake|leader|quiet <nonce> <body>
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> answer <private:id> <question-id> Yes|No <nonce>
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> age-link <handle> [hours]
//   npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> claim <private:id>
// write is the box on the peek-in page (src/lib/person-messages.ts), with its
// switch on for this run alone, and answer the Yes or No above it; age-link plays a day passing since a bot was
// linked, as claiming a group waits for.
import postgres from "postgres";
import { ApiError } from "../src/lib/http";
import { ensureHuman, releaseBot } from "../src/lib/humans";
import { readGroupForPerson } from "../src/lib/peek";
import { answerAsPerson, postAsPerson } from "../src/lib/person-messages";
import {
  claimChannel,
  listPersonChannels,
  pickLeader,
  refId,
  setOwnBots,
  startChannel,
} from "../src/lib/private-channels";
import { isThrowaway } from "./throwaway";

const url = process.env.EVAL_DATABASE_URL;
const [id, what, ...rest] = process.argv.slice(2);
if (
  !isThrowaway(url) ||
  !url ||
  !id ||
  ![
    "start",
    "add",
    "take-out",
    "lead",
    "list",
    "release",
    "peek",
    "write",
    "answer",
    "age-link",
    "claim",
  ].includes(what ?? "")
) {
  console.error(
    "Usage: EVAL_DATABASE_URL=<local _test database> npx tsx --conditions=react-server evals/person-groups.ts <sign-in-id> start <leader|-> <handle>... | add|take-out|lead <private:id> <handle> | list | release <handle> | peek <private:id> [pages] | write <private:id> wake|leader|quiet <nonce> <body> | answer <private:id> <question-id> Yes|No <nonce> | age-link <handle> [hours] | claim <private:id>",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  let out: unknown;
  if (what === "list") {
    const human = await sql.begin((tx) => ensureHuman(tx, id));
    out = await listPersonChannels(sql, human);
  } else if (what === "peek") {
    // What /account/channels/<id> shows the person, read as the page reads it.
    const human = await sql.begin((tx) => ensureHuman(tx, id));
    // An optional count of pages reads that many of the newest at once, as
    // the page does when earlier messages load in place.
    const pages = rest[1] === undefined ? undefined : Number(rest[1]);
    out = await readGroupForPerson(
      sql,
      human,
      refId(rest[0] ?? "") ?? 0,
      pages === undefined ? {} : { pages },
    );
  } else if (what === "write") {
    const [channel = "", wake = "", nonce = "", ...words] = rest;
    process.env.UNPROMPTED_PERSON_POSTS = "1";
    out = await postAsPerson(sql, {
      authUserId: id,
      channel,
      body: words.join(" "),
      wake: wake === "leader" ? "leader" : wake === "wake",
      nonce,
      ipHash: null,
    });
  } else if (what === "answer") {
    const [channel = "", question = "", answer = "", nonce = ""] = rest;
    process.env.UNPROMPTED_PERSON_POSTS = "1";
    out = await answerAsPerson(sql, {
      authUserId: id,
      channel,
      question,
      answer,
      nonce,
      ipHash: null,
    });
  } else if (what === "age-link") {
    const [handle = "", hours = "25"] = rest;
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE bots DISABLE TRIGGER bots_linked_at`;
      const rows = await tx`
        UPDATE bots SET linked_at = now() - make_interval(hours => ${Number(hours)})
        WHERE handle = ${handle} AND owner_id IS NOT NULL RETURNING id`;
      await tx`ALTER TABLE bots ENABLE TRIGGER bots_linked_at`;
      if (rows.length !== 1) throw new Error(`@${handle} isn't linked`);
    });
    out = { aged: handle };
  } else if (what === "claim") {
    out = await claimChannel(sql, id, rest[0] ?? "", null);
  } else if (what === "release") {
    await releaseBot(sql, id, rest[0] ?? "", null);
    out = { released: rest[0] };
  } else if (what === "start") {
    const [leader, ...handles] = rest;
    out = await startChannel(
      sql,
      id,
      handles,
      leader === "-" ? undefined : leader,
      null,
    );
  } else {
    const [channel = "", handle = ""] = rest;
    out =
      what === "lead"
        ? await pickLeader(sql, id, channel, handle, null)
        : await setOwnBots(
            sql,
            id,
            channel,
            what === "add" ? [handle] : [],
            what === "take-out" ? [handle] : [],
            null,
          );
  }
  console.log(JSON.stringify(out));
} catch (err) {
  if (!(err instanceof ApiError)) throw err;
  console.log(JSON.stringify({ refused: err.code, message: err.message }));
} finally {
  await sql.end();
}
