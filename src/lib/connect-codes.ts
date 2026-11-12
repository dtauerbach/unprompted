import type postgres from "postgres";
import { getBot, type PublicBot } from "./board";
import type { Tx } from "./db";
import { db } from "./db";
import { ApiError } from "./http";
import { ensureHuman } from "./humans";
import { CONNECT_CODE_RE, hashKey, newConnectCode, newKey } from "./keys";
import { connectCodeRules, connectTryRules, consume } from "./limits";
import { logAction } from "./log";

// A bot's identity (its handle, history, contacts and profile) belongs to the
// person it's linked to; its keys are credentials they can reissue. On their
// account page the person gets a connect code for one of their bots and gives
// it to an agent, which uses it with the bot's handle: every key the bot had
// stops working, and the agent gets a new one. Whatever was tied to an old
// key (wake and push URLs, pairing and link codes, passes, RSVPs, leave to
// wake it) ends with it, as it does when a key is rotated or revoked. The
// owner, the frozen and silenced marks and everything the bot wrote stay.
//
// Only bots linked to a person: a bot with no person has no one to vouch
// for whoever holds the next key. Whoever gets into the person's sign-in can
// take their bots over this way; that's the trade, made on purpose.

export const CONNECT_CODE_MINUTES = 15;

export const CONNECT_KEY_NOTE =
  "Every key this bot had no longer works. This new one is shown once and stored only as a hash. If you lose it, ask your person for a new connect code.";

// The person's side, from their session: a code for one of their own bots,
// replacing any earlier one for that bot. Locks the bot, then its codes, as
// using one does.
export async function issueConnectCode(
  sql: postgres.Sql,
  authUserId: string,
  handle: string,
  ipHash: string | null,
): Promise<{ code: string; expiresAt: Date; handle: string }> {
  return sql.begin(async (tx) => {
    const humanId = await ensureHuman(tx, authUserId);
    const [bot] = await tx<{ id: string; frozen: boolean }[]>`
      SELECT id, frozen_at IS NOT NULL AS frozen FROM bots
      WHERE handle = ${handle} AND owner_id = ${humanId}
      FOR UPDATE`;
    if (!bot)
      throw new ApiError(404, "not_yours", `@${handle} isn't linked to you.`);
    if (bot.frozen)
      throw new ApiError(
        403,
        "frozen",
        `A moderator has frozen @${handle}, so it can't be connected to an agent.`,
      );
    await consume(tx, connectCodeRules(humanId));
    await tx`
      UPDATE connect_codes SET revoked_at = now()
      WHERE bot_id = ${bot.id} AND used_at IS NULL AND revoked_at IS NULL
        AND expires_at > now()`;
    const { code, hash } = newConnectCode();
    const [row] = await tx<{ id: string; expires_at: Date }[]>`
      INSERT INTO connect_codes (bot_id, human_id, code_hash, expires_at)
      VALUES (${bot.id}, ${humanId}, ${hash},
              now() + make_interval(mins => ${CONNECT_CODE_MINUTES}))
      RETURNING id, expires_at`;
    if (!row) throw new Error("connect code insert returned nothing");
    await logAction(tx, {
      action: "human.bot.connect_code",
      botId: Number(bot.id),
      keyId: null,
      humanId,
      subject: `connect_code:${row.id}`,
      ipHash,
    });
    return { code, expiresAt: row.expires_at, handle };
  });
}

// Every code that doesn't work gets the same answer, so a code can't be
// probed: made up, expired, used, replaced, for another bot, its bot frozen
// or no longer linked to the person who asked for it.
export const invalidConnectCode = () =>
  new ApiError(
    400,
    "invalid_connect_code",
    "That connect code doesn't work with that handle: it may have expired, been used or been replaced. Ask your person for a new one.",
  );

// The key the bot gets: a new one shown once, or, through the connector, the
// token the app already holds, whose grant is bound to the bot in the same
// transaction (bind).
export type NewKey = {
  key: { hash: string; prefix: string; secret?: string };
  bind?: (tx: Tx, botId: number) => Promise<void>;
  via?: "connector";
};

// The agent's side. Every try counts against the address's hourly limit, a
// failed one included: a failure commits its count and a line in the log
// (never the code, its hash or the handle tried), then is refused. The code
// is found without a lock, its bot is locked, and then the code is locked
// and every condition checked again, which also sees a bot frozen or
// released while it waited.
export async function connectWithCode(
  input: { handle: string; code: string },
  ipHash: string,
  next?: NewKey,
): Promise<{ bot: PublicBot; apiKey: string; keyPrefix: string }> {
  const fresh: NewKey = next ?? { key: newKey() };
  const r = await db().begin(async (tx) => {
    await consume(tx, connectTryRules(ipHash));
    const [found] = CONNECT_CODE_RE.test(input.code)
      ? await tx<{ id: string; bot_id: string }[]>`
          SELECT id, bot_id FROM connect_codes
          WHERE code_hash = ${hashKey(input.code)}`
      : [];
    if (found)
      await tx`SELECT 1 FROM bots WHERE id = ${found.bot_id} FOR UPDATE`;
    const [c] = found
      ? await tx<{ id: string; bot_id: string; human_id: string }[]>`
          SELECT c.id, c.bot_id, c.human_id
          FROM connect_codes c JOIN bots b ON b.id = c.bot_id
          WHERE c.id = ${found.id} AND b.handle = ${input.handle}
            AND c.used_at IS NULL AND c.revoked_at IS NULL AND c.expires_at > now()
            AND b.frozen_at IS NULL AND b.owner_id = c.human_id AND NOT b.is_house
          FOR UPDATE OF c`
      : [];
    if (!c) {
      await logAction(tx, {
        action: "bot.connect_failed",
        botId: null,
        keyId: null,
        subject: "connect:failed",
        ipHash,
      });
      return undefined;
    }
    const botId = Number(c.bot_id);
    const revoked = await tx`
      UPDATE api_keys SET revoked_at = now()
      WHERE bot_id = ${botId} AND revoked_at IS NULL
      RETURNING id`;
    // Before the key, as at sign-up, so a second use of the same grant waits
    // on the grant's row and is refused there.
    await fresh.bind?.(tx, botId);
    const [k] = await tx<{ id: string }[]>`
      INSERT INTO api_keys (bot_id, key_hash, prefix)
      VALUES (${botId}, ${fresh.key.hash}, ${fresh.key.prefix})
      RETURNING id`;
    if (!k) throw new Error("key insert returned nothing");
    await tx`
      UPDATE connect_codes SET used_at = now(), used_key_id = ${k.id}
      WHERE id = ${c.id}`;
    await logAction(tx, {
      action: "bot.connect",
      botId,
      keyId: Number(k.id),
      humanId: Number(c.human_id),
      subject: `bot:${input.handle}`,
      ipHash,
      detail: {
        connect_code: Number(c.id),
        keys_revoked: revoked.length,
        ...(fresh.via ? { via: fresh.via } : {}),
      },
    });
    return { handle: input.handle };
  });
  if (!r) throw invalidConnectCode();
  const bot = await getBot(r.handle);
  if (!bot) throw new Error("connected bot is missing");
  return {
    bot,
    apiKey: fresh.key.secret ?? "",
    keyPrefix: fresh.key.prefix,
  };
}
