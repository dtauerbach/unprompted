import {
  POST as blockRoute,
  DELETE as unblockRoute,
} from "@/app/v1/bots/[handle]/block/route";
import { DELETE as removeRoute } from "@/app/v1/me/contacts/[handle]/route";
import { GET as contactsRoute } from "@/app/v1/me/contacts/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as createRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as reportRoute } from "@/app/v1/messages/[id]/report/route";
import { GET as readRoute, POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { db } from "@/lib/db";
import { call, register } from "./helpers";

// One run of everything two bots do as a pair today: a request and its
// answer, a second request refused, pairing with a code and writing between
// contacts, a block and an unblock, removing a contact, a report, a new bot
// refused, and every read of it. Each answer is kept with what varies from run
// to run (times, codes) blanked out. The answers were recorded on the code
// before pairs became private channels of two (src/test/fixtures/
// pair-golden.json), and pair-golden.test.ts holds today's code to them, so
// moving pairs under private channels changes nothing a bot sees.

type Bot = { handle: string; key: string };
export type Step = { step: string; status: number; body: unknown };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
const CODE = /^pair_[a-z0-9]{26}$/;

// Blanks out times and codes, which differ on every run.
function steady(v: unknown): unknown {
  if (typeof v === "string") {
    if (ISO.test(v)) return "<time>";
    if (CODE.test(v)) return "<code>";
    return v;
  }
  if (Array.isArray(v)) return v.map(steady);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        k === "retry_after_seconds" ? "<seconds>" : steady(x),
      ]),
    );
  return v;
}

export async function pairScenario(): Promise<Step[]> {
  const steps: Step[] = [];
  const keep = (step: string, r: { status: number; body: unknown }) => {
    steps.push({ step, status: r.status, body: steady(r.body) });
    return r;
  };
  // A bot past its first day, with its inbox open unless told otherwise.
  const bot = async (handle: string, open = true) => {
    const b = await register(handle);
    await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
    if (open) await call(inboxRoute, { key: b.key, body: { open: true } });
    return b;
  };
  const send = (from: Bot, to: string, body: string) =>
    call(sendRoute, { key: from.key, body: { to, body } });
  const read = (b: Bot, query = "") =>
    call(readRoute, { key: b.key, path: `/v1/messages${query}` });
  const messages = async (b: Bot, query = "") => {
    const r = await call(digestRoute, {
      key: b.key,
      path: `/v1/me/digest${query}`,
    });
    return { status: r.status, body: r.body.messages };
  };

  const alice = await bot("alice");
  const bob = await bot("bob");
  const carol = await bot("carol", false);
  const dave = await bot("dave");

  // A request, a second one refused, the answer that accepts it.
  keep("alice asks bob", await send(alice, "bob", "Hello bob."));
  keep("alice asks again", await send(alice, "bob", "Still there?"));
  keep("bob's list", await read(bob));
  keep("bob's digest", await messages(bob, "?messages_since=0"));
  keep("bob answers", await send(bob, "alice", "Hi alice."));
  keep("alice reads bob", await read(alice, "?with=bob"));
  keep("alice writes again", await send(alice, "bob", "Good to meet you."));

  // Carol's inbox is closed: dave can't ask, but pairing lets them talk.
  keep("dave asks carol", await send(dave, "carol", "Hi carol."));
  const code = keep(
    "carol makes a code",
    await call(createRoute, { key: carol.key, body: { for: "dave" } }),
  );
  keep(
    "dave redeems it",
    await call(redeemRoute, {
      key: dave.key,
      body: { code: (code.body as { code: string }).code },
    }),
  );
  keep("dave writes carol", await send(dave, "carol", "Paired now."));
  keep("carol writes dave", await send(carol, "dave", "So we are."));
  keep("carol's contacts", await call(contactsRoute, { key: carol.key }));
  keep("carol reads dave", await read(carol, "?with=dave"));
  keep("dave's digest", await messages(dave, "?messages_since=0"));

  // A block stops both ways; unblocking lets the conversation go on.
  keep(
    "bob blocks alice",
    await call(blockRoute, { key: bob.key, params: { handle: "alice" } }),
  );
  keep("alice writes blocked", await send(alice, "bob", "Hello?"));
  keep("bob writes alice", await send(bob, "alice", "Blocked you."));
  keep(
    "bob unblocks alice",
    await call(unblockRoute, {
      key: bob.key,
      method: "DELETE",
      params: { handle: "alice" },
    }),
  );
  keep("alice writes unblocked", await send(alice, "bob", "Back again."));

  // Removing the contact sends dave back to carol's closed inbox.
  keep(
    "carol removes dave",
    await call(removeRoute, {
      key: carol.key,
      method: "DELETE",
      params: { handle: "dave" },
    }),
  );
  keep("dave writes after", await send(dave, "carol", "Still paired?"));
  keep("carol's contacts after", await call(contactsRoute, { key: carol.key }));

  // Bob reports alice's first message; only the bot it went to can.
  keep(
    "alice reports her own",
    await call(reportRoute, {
      key: alice.key,
      params: { id: "1" },
      body: { reason: "spam" },
    }),
  );
  keep(
    "bob reports it",
    await call(reportRoute, {
      key: bob.key,
      params: { id: "1" },
      body: { reason: "spam" },
    }),
  );

  // A new bot can't start a conversation, but can answer one.
  const eve = await register("eve");
  await call(inboxRoute, { key: eve.key, body: { open: true } });
  keep("eve asks alice", await send(eve, "alice", "New here."));
  keep("alice asks eve", await send(alice, "eve", "Welcome."));
  keep("eve answers", await send(eve, "alice", "Thanks."));

  keep("alice's list", await read(alice));
  keep("alice reads eve", await read(alice, "?with=eve"));
  keep("alice reads bob after", await read(alice, "?with=bob"));
  keep("alice's digest", await messages(alice, "?messages_since=0"));
  keep("bob's digest after", await messages(bob, "?messages_since=1"));
  return steps;
}
