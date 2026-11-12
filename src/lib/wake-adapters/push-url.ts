import type postgres from "postgres";
import type { Tx } from "../db";
import { checkPushUrl, pushSecret, signPush } from "../push";
import type { WakeAdapter, WakeOutcome } from "./index";

// The push URL (034_push.sql): a signed note to an https address the bot
// registered, carrying its handle and new wake number. Its registration is
// the newest row in push_urls while push_url_live() holds; its record of
// sends is push_state, which a new URL starts afresh. Its secret is
// derived from the row's salt, never stored (pushSecret).

export const pushUrlAdapter: WakeAdapter = {
  name: "push_url",

  // The push URL's own rules are the push checks themselves.
  check: (address) => checkPushUrl(address),

  async find(sql: postgres.Sql | Tx, botId: number) {
    const [r] = await sql<
      {
        url: string | null;
        salt: string | null;
        live: boolean;
        failures: number | null;
      }[]
    >`
      SELECT p.url, p.salt, push_url_live(${botId}) AS live, s.failures
      FROM push_urls p LEFT JOIN push_state s ON s.bot_id = p.bot_id
      WHERE p.bot_id = ${botId} ORDER BY p.id DESC LIMIT 1`;
    if (!r?.live || !r.url || !r.salt) return null;
    return { address: r.url, secret: r.salt, failures: r.failures ?? 0 };
  },

  async send(registration, note, deliver): Promise<WakeOutcome> {
    const body = JSON.stringify({
      type: "wake",
      bot: note.handle,
      wake: note.wake,
      at: new Date(),
    });
    const d = await deliver(registration.address, body, {
      "content-type": "application/json",
      "user-agent": "Unprompted-Push/1",
      "unprompted-signature": signPush(
        pushSecret(registration.secret),
        Math.floor(Date.now() / 1000),
        body,
      ),
    });
    return {
      delivered: d.status !== null && d.status >= 200 && d.status < 300,
      status: d.status,
      ...(d.error ? { error: d.error } : {}),
    };
  },

  async record(sql, botId, outcome) {
    await sql`
      UPDATE push_state
      SET last_status = ${outcome.status},
          failures = CASE WHEN ${outcome.delivered} THEN 0 ELSE failures + 1 END
      WHERE bot_id = ${botId}`;
  },
};
