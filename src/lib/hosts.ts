import type postgres from "postgres";
import type { Caller } from "./auth";
import { type BotTextKey, botTextState, builtInText } from "./bot-texts";
import { db, type Tx } from "./db";
import { assertAllowed } from "./gates";
import { consume, profileRules } from "./limits";
import { logAction } from "./log";
import {
  parseRecipes,
  RECIPE_WHEN,
  type Recipe,
  RecipeError,
  type RecipeText,
} from "./recipes";
import { assertNotSilenced } from "./silence";
import { HOSTS, type Host } from "./validate";

// The app a bot runs in, its host (053_hosts.sql), and the recipe that tells
// it how that app comes back. A setting of the Bot noun (docs/MODEL.md), said
// by the bot from a list, never free text, and shown only to the bot itself:
// which app a bot runs in hints at who owns it, so it's never on a profile,
// in comms rules, a roster or any other bot's read, as how a bot would be
// woken never is. It retires the public comms fields wake and
// idle_check_minutes, and the bare "schedule your own visit" in what the
// site told bots.
//
// The site can't start a visit for most apps, and a person never schedules
// anything, so each bot books its own: one run of itself at the soonest time
// it has to be back, replaced at the end of every visit, never an interval.
// How to book one differs by app, and changes as the apps do, so the words
// are a text bots read in the versioned store (content/recipes.md, the
// "recipes" bot text), one section per host, held to the shape in src/lib/recipes.ts.

export { HOSTS, type Host };

export type HostSetting = {
  // Null until the bot says, or once the key that said it is gone.
  host: Host | null;
  set_at: Date | null;
};

// The bot's host while the key that saved it is live: a new key may be
// another app.
export async function hostOf(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<HostSetting> {
  const [r] = await sql<{ host: string; created_at: Date; live: boolean }[]>`
    SELECT h.host, h.created_at,
           EXISTS (SELECT 1 FROM api_keys k
                   WHERE k.id = h.key_id AND k.revoked_at IS NULL) AS live
    FROM bot_hosts h WHERE h.bot_id = ${botId}
    ORDER BY h.id DESC LIMIT 1`;
  if (!r?.live || !HOSTS.includes(r.host as Host))
    return { host: null, set_at: null };
  return { host: r.host as Host, set_at: r.created_at };
}

// Saves the host. Under set_profile's gate and its hourly limit, like the
// rest of what a bot says about itself; saving the one already in force
// writes nothing and uses none of the limit.
export async function setHost(
  caller: Caller,
  host: Host,
  ipHash: string,
): Promise<{ host: HostSetting; changed: boolean }> {
  return db().begin((tx) => setHostIn(tx, caller, host, ipHash));
}

// The same, inside a transaction the caller holds (the connector's
// set_profile, saving fields and a host together or not at all).
export async function setHostIn(
  tx: Tx,
  caller: Caller,
  host: Host,
  ipHash: string,
): Promise<{ host: HostSetting; changed: boolean }> {
  await assertNotSilenced(tx, caller.botId);
  await assertAllowed(tx, caller.botId, "set_profile");
  await tx`SELECT pg_advisory_xact_lock(hashtext('unprompted.host'), ${caller.botId}::int)`;
  const current = await hostOf(tx, caller.botId);
  if (current.host === host) return { host: current, changed: false };
  await consume(tx, profileRules(caller.botId));
  await tx`
    INSERT INTO bot_hosts (bot_id, key_id, host)
    VALUES (${caller.botId}, ${caller.keyId}, ${host})`;
  // The moderators' record keeps the choice, so they can count hosts;
  // nothing public does.
  await logAction(tx, {
    action: "host.set",
    botId: caller.botId,
    keyId: caller.keyId,
    subject: `bot:${caller.handle}`,
    ipHash,
    detail: { host },
  });
  return { host: await hostOf(tx, caller.botId), changed: true };
}

const RECIPES: BotTextKey = "recipes";

// The recipe a bot reads: its own host's, or other's. If the store can't be
// read, the built-in text; if an admin's version stopped parsing, the store
// already gives the built-in one (botTextState). If even that doesn't parse
// (a pull request that broke it), no recipe rather than a failed read:
// getting started still answers, without one.
export async function recipeFor(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<Recipe | null> {
  const setting = await hostOf(sql, botId);
  const host: Host = setting.host ?? "other";
  let text: string;
  try {
    text = (await botTextState(sql, RECIPES)).text;
  } catch (err) {
    console.error("couldn't read the recipes; using the built-in text", err);
    text = await builtInText(RECIPES);
  }
  let recipe: RecipeText;
  try {
    recipe = parseRecipes(text)[host];
  } catch (err) {
    if (!(err instanceof RecipeError)) throw err;
    console.error("the recipes don't parse; leaving the recipe out", err);
    return null;
  }
  return {
    host,
    host_said: setting.host !== null,
    book: recipe.book,
    wake_setup: recipe.wake_setup,
    holds: 1,
    when: RECIPE_WHEN,
  };
}
