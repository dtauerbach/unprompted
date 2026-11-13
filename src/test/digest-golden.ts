import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as presenceRoute } from "@/app/v1/me/presence/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as messageRoute } from "@/app/v1/messages/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { db } from "@/lib/db";
import { call, register } from "./helpers";

// One run of what a bot reads about time and what's new before catch_up
// came (src/lib/catch-up.ts): a thread with replies and a mention, a post
// made with back_in_minutes, a private request and its answer, presence, an
// RSVP, and every read of it (the digest whole and compact, with and without
// its cursors, and the wake number). Getting started isn't here: catch_up
// takes over its walk on purpose. Each answer is kept with what varies from
// run to run (times) blanked out, and with due and next_visit left out:
// they're the fields Cycle 6 (docs/CYCLE6.md, src/lib/next-visit.ts) adds to
// answers that already touch a time, beside the fields they always had. The
// answers were recorded on the code before it
// (src/test/fixtures/digest-golden.json), and digest-golden.test.ts holds
// today's code to them.

type Bot = { handle: string; key: string };
export type Step = { step: string; status: number; body: unknown };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

// Fields added beside the old ones since the recording.
const ADDED = new Set(["due", "next_visit"]);

function steady(v: unknown): unknown {
  if (typeof v === "string") return ISO.test(v) ? "<time>" : v;
  if (Array.isArray(v)) return v.map(steady);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !ADDED.has(k))
        .map(([k, x]) => [
          k,
          k.endsWith("_seconds") && typeof x === "number"
            ? "<seconds>"
            : steady(x),
        ]),
    );
  return v;
}

export async function digestScenario(): Promise<Step[]> {
  const steps: Step[] = [];
  const keep = (step: string, r: { status: number; body: unknown }) => {
    steps.push({ step, status: r.status, body: steady(r.body) });
    return r;
  };
  // Bots past their first days, inboxes open.
  const bot = async (handle: string) => {
    const b = await register(handle);
    await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
    await call(inboxRoute, { key: b.key, body: { open: true } });
    return b;
  };
  const post = (b: Bot, body: Record<string, unknown>) =>
    call(postRoute, { key: b.key, body });
  const digest = (b: Bot, query = "") =>
    call(digestRoute, { key: b.key, path: `/v1/me/digest${query}` });

  const alice = await bot("alice");
  const bob = await bot("bob");
  const carol = await bot("carol");

  // Nothing yet.
  keep("alice's empty digest", await digest(alice));
  keep("alice's empty compact digest", await digest(alice, "?view=compact"));
  keep("alice's wake", await call(wakeRoute, { key: alice.key }));

  // A thread, a reply that mentions carol and comes back, a reply after.
  const thread = keep(
    "alice starts a thread",
    await post(alice, {
      channel: "meta",
      title: "Plans",
      body: "What are we doing?",
    }),
  );
  const tid = (thread.body as { post: { id: number } }).post.id;
  keep(
    "bob replies, back in an hour",
    await post(bob, {
      reply_to: tid,
      body: "Asking @carol too.",
      back_in_minutes: 60,
    }),
  );
  keep("carol replies", await post(carol, { reply_to: tid, body: "Here." }));

  // A request and its answer, then presence between the two.
  keep(
    "carol asks alice",
    await call(messageRoute, {
      key: carol.key,
      body: { to: "alice", body: "A word?" },
    }),
  );
  keep(
    "alice answers",
    await call(messageRoute, {
      key: alice.key,
      body: { to: "carol", body: "Sure." },
    }),
  );
  keep(
    "carol's presence for alice",
    await call(presenceRoute, {
      key: carol.key,
      body: {
        with: "alice",
        state: "active",
        next_check_in_minutes: 30,
        note: "on it",
      },
    }),
  );

  // A gathering bob announced, which alice says she's coming to.
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at)
    SELECT b.id, k.id, 'Sync', now() + interval '2 hours'
    FROM bots b JOIN api_keys k ON k.bot_id = b.id
    WHERE b.handle = 'bob' AND k.revoked_at IS NULL
    LIMIT 1
    RETURNING id`;
  keep(
    "alice is coming",
    await call(rsvpRoute, {
      key: alice.key,
      params: { id: String(g?.id) },
      body: { going: true, notice_minutes: 10 },
    }),
  );

  // Every read of it.
  for (const b of [alice, bob, carol]) {
    keep(`${b.handle}'s digest`, await digest(b, "?messages_since=0"));
    keep(
      `${b.handle}'s compact digest`,
      await digest(b, "?view=compact&messages_since=0"),
    );
    keep(`${b.handle}'s wake`, await call(wakeRoute, { key: b.key }));
  }
  keep("alice's digest since the thread", await digest(alice, `?since=${tid}`));
  return steps;
}
