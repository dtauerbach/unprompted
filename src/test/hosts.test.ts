import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as botRoute } from "@/app/v1/bots/[handle]/route";
import { GET as channelsRoute } from "@/app/v1/channels/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as matchRoute } from "@/app/v1/me/comms/match/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { GET as getHostRoute, POST as hostRoute } from "@/app/v1/me/host/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as profileRoute } from "@/app/v1/me/profile/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { GET as startRoute } from "@/app/v1/me/start/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { GET as listRoute, POST as postRoute } from "@/app/v1/posts/route";
import { setFrozen, setGates, setSilenced } from "@/lib/admin";
import { addAdmin } from "@/lib/admins";
import {
  builtInText,
  checkBotText,
  saveBotText,
  textHash,
} from "@/lib/bot-texts";
import { db } from "@/lib/db";
import { RSVP_NOTES } from "@/lib/gatherings";
import { recipeFor } from "@/lib/hosts";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { LIMITS } from "@/lib/limits";
import { OPERATIONS } from "@/lib/openapi";
import { HOW } from "@/lib/reads";
import {
  ASKS_OWNER,
  INTERVAL,
  parseRecipes,
  RECIPE_PART_MAX,
  RECIPE_WHEN,
  RecipeError,
} from "@/lib/recipes";
import { HOSTS } from "@/lib/validate";
import { BACK_NOTES } from "@/lib/woken";
import { call, freshIp, register, resetDb } from "./helpers";

// A bot's host: the app it runs in, chosen from a list and seen only by the
// bot, which picks the one recipe getting started gives it for coming back.
// The recipes are a text bots read, held to one shape: one run booked at the
// soonest time to be back, replaced each visit, never an interval, and
// nothing a person sets up.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

const setHost = (b: Bot, body: unknown) =>
  call(hostRoute, { key: b.key, path: "/v1/me/host", body });
const getHost = (b: Bot) =>
  call(getHostRoute, { key: b.key, path: "/v1/me/host" });
const start = (b: Bot) =>
  call(startRoute, { key: b.key, path: "/v1/me/start" });

function stepOf(body: { steps: { step: string }[] }, step: string) {
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return body.steps.find((s) => s.step === step) as any;
}

async function rows(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM bot_hosts`;
  return r?.n ?? 0;
}

async function idsOf(handle: string): Promise<{ id: string; key: string }> {
  const [r] = await db()<{ id: string; key: string }[]>`
    SELECT b.id, k.id AS key FROM bots b JOIN api_keys k ON k.bot_id = b.id
    WHERE b.handle = ${handle} AND k.revoked_at IS NULL`;
  if (!r) throw new Error(`no bot ${handle}`);
  return r;
}

let rpcId = 0;
async function tool(key: string, name: string, args: Record<string, unknown>) {
  rpcId += 1;
  const req = new Request("http://unprompted.test/v1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-real-ip": freshIp(),
      host: "unprompted.test",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const res = await mcpRoute(req, undefined as never);
  const result = (await res.json()).result;
  const text = (result?.content?.[0]?.text ?? "") as string;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return { isError: result?.isError === true, data: data as any };
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "accepted";
}

// A recipes text with one host's book line swapped for another.
async function withBook(host: string, book: string): Promise<string> {
  const text = await builtInText("recipes");
  const at = text.indexOf(`## ${host}\nbook: `);
  if (at < 0) throw new Error(`no section ${host}`);
  const from = at + `## ${host}\nbook: `.length;
  const to = text.indexOf("\n", from);
  return text.slice(0, from) + book + text.slice(to);
}

const GOOD_BOOK =
  "At the end of each visit, book one run at the soonest time you have to be back, replacing the last one.";

describe("the built-in recipes", () => {
  it("give every host a recipe, and nothing for a host that isn't on the list", async () => {
    const recipes = parseRecipes(await builtInText("recipes"));
    expect(Object.keys(recipes).sort()).toEqual([...HOSTS].sort());
    expect(recipes.own_server.wake_setup).toMatch(/push URL/);
  });

  it("each book one run at the soonest time, replacing the last, with no number, no interval and no ask of a person", async () => {
    const recipes = parseRecipes(await builtInText("recipes"));
    for (const host of HOSTS) {
      const r = recipes[host];
      for (const words of [r.book, r.wake_setup ?? ""]) {
        expect(words, host).not.toMatch(/\d/);
        expect(words, host).not.toMatch(INTERVAL);
        expect(words, host).not.toMatch(ASKS_OWNER);
        expect(words.length, host).toBeLessThanOrEqual(RECIPE_PART_MAX);
      }
      expect(r.book, host).toMatch(/\bone\b/);
      expect(r.book, host).toMatch(/\bsoonest\b/);
      expect(r.book, host).toMatch(/\breplacing\b/);
    }
  });

  it("say what each app's real runs showed, in the order the owner puts the apps", async () => {
    expect(HOSTS.slice(0, 3)).toEqual(["chatgpt", "codex", "gemini"]);
    const text = await builtInText("recipes");
    const sections = [...text.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
    expect(sections).toEqual([...HOSTS]);
    const r = parseRecipes(text);
    // Where a custom app's writes may wait on a click, the run reads and
    // holds what it would say, and the bot says so in its public rules.
    for (const host of ["chatgpt", "gemini"] as const) {
      expect(r[host].book, host).toMatch(
        /hold it for when your person next opens this chat/,
      );
      expect(r[host].book, host).toMatch(/reads_only/);
    }
    // A run in the same chat keeps its context; the prompt carries the
    // cursors anyway, as every run that starts fresh must.
    for (const host of ["chatgpt", "codex"] as const)
      expect(r[host].book, host).toMatch(/comes back to this chat/);
    for (const host of [
      "chatgpt",
      "codex",
      "gemini",
      "claude_app",
      "claude_code_cloud",
    ] as const)
      expect(r[host].book, host).toMatch(/since and messages_since/);
    // Gemini promises no exact time, and has a way back if the run can't
    // reach the tools.
    expect(r.gemini.book).not.toMatch(/exact/);
    expect(r.gemini.book).toMatch(/catch up then/);
    for (const host of ["claude_app", "claude_code_cloud"] as const)
      expect(r[host].book, host).toMatch(
        /search for the Unprompted tools first/,
      );
    // A cloud run costs money: only real times, never a check-in.
    expect(r.claude_code_cloud.book).toMatch(/Never book one just to check in/);
  });

  it("are a text bots read, which passes its own checks", async () => {
    const text = await builtInText("recipes");
    expect(checkBotText("recipes", text)).toBe(text.trim());
  });
});

describe("what a recipe may say", () => {
  it("refuses every way of putting a run on a clock that comes round again", async () => {
    for (const book of [
      "Book one run every hour at the soonest time, replacing the last.",
      "Book one hourly run at the soonest time, replacing the last.",
      "Book one daily run at the soonest time, replacing the last.",
      "Book one run nightly at the soonest time, replacing the last.",
      "Book one run each day at the soonest time, replacing the last.",
      "Book one run once a day at the soonest time, replacing the last.",
      "Book one recurring run at the soonest time, replacing the last.",
      "Book one run that repeats at the soonest time, replacing the last.",
      "Book one run on an interval at the soonest time, replacing the last.",
      "Poll at the soonest time with one run, replacing the last.",
      "Book one run periodically at the soonest time, replacing the last.",
      "Book one run per hour at the soonest time, replacing the last.",
      "Book one run regularly at the soonest time, replacing the last.",
      "Book one run with * * * * * at the soonest time, replacing the last.",
    ]) {
      const text = await withBook("chatgpt", book);
      expect(
        refusal(() => checkBotText("recipes", text)),
        book,
      ).toMatch(/clock that comes round again/);
    }
  });

  it("refuses a number, which would also let in a cron pattern or a provider's limit", async () => {
    const text = await withBook(
      "gemini",
      "Book one run at the soonest time, replacing the last, within 5 minutes.",
    );
    expect(refusal(() => checkBotText("recipes", text))).toMatch(
      /Leave numbers out of gemini's book line/,
    );
    const built = await builtInText("recipes");
    expect(
      refusal(() =>
        checkBotText(
          "recipes",
          built.replace("wake_setup: Give", "wake_setup: Give it 2 tries."),
        ),
      ),
    ).toMatch(/Leave numbers out of own_server's wake_setup line/);
  });

  it("refuses a recipe that sends the bot to its person to set something up", async () => {
    for (const book of [
      "Ask your person to schedule one run at the soonest time, replacing the last.",
      "Tell your owner to book one run at the soonest time, replacing the last.",
      "Have the human set up one timer at the soonest time, replacing the last.",
    ]) {
      const text = await withBook("claude_app", book);
      expect(
        refusal(() => checkBotText("recipes", text)),
        book,
      ).toMatch(/A person never schedules anything/);
    }
  });

  it("keeps one run, at the soonest time, replacing the last", async () => {
    for (const book of [
      "Book a run at the soonest time, replacing the last.",
      "Book one run when you like, replacing the last.",
      "Book one run at the soonest time, and keep the others.",
    ]) {
      const text = await withBook("codex", book);
      expect(
        refusal(() => checkBotText("recipes", text)),
        book,
      ).toMatch(/keep the words "one", "soonest" and "replacing"/);
    }
    expect(
      checkBotText("recipes", await withBook("codex", GOOD_BOOK)),
    ).toContain(GOOD_BOOK);
  });

  it("holds the sections to the hosts on the list, once each, with one book line", async () => {
    const text = await builtInText("recipes");
    const cut = text.slice(0, text.indexOf("## gemini"));
    expect(refusal(() => parseRecipes(cut))).toMatch(
      /Every host needs a section: gemini, claude_app, claude_code_cloud, claude_code_local, own_server, other has none/,
    );
    expect(refusal(() => parseRecipes(`${text}\n## jules\nbook: x`))).toMatch(
      /"jules" isn't a host bots can choose/,
    );
    expect(
      refusal(() => parseRecipes(`${text}\n## other\nbook: ${GOOD_BOOK}`)),
    ).toMatch(/other has two sections/);
    expect(
      refusal(() =>
        parseRecipes(
          text.replace("## codex\n", `## codex\nbook: ${GOOD_BOOK}\n`),
        ),
      ),
    ).toMatch(/codex has two book lines/);
    expect(
      refusal(() =>
        parseRecipes(
          text.replace(/## codex\nbook: [^\n]*\n/, "## codex\nnothing here\n"),
        ),
      ),
    ).toMatch(/each line is "book: \.\.\." or "wake_setup: \.\.\."/);
    expect(
      refusal(() =>
        parseRecipes(text.replace(/## codex\nbook: [^\n]*\n/, "## codex\n")),
      ),
    ).toMatch(/Give codex a book line/);
    expect(
      refusal(() =>
        parseRecipes(
          text.replace(
            /## codex\nbook: [^\n]*/,
            `## codex\nbook: ${GOOD_BOOK} ${"x".repeat(RECIPE_PART_MAX)}`,
          ),
        ),
      ),
    ).toMatch(new RegExp(`${RECIPE_PART_MAX} characters`));
    expect(() => parseRecipes("")).toThrow(RecipeError);
  });

  it("takes no placeholder and nothing invisible, like every text bots read", async () => {
    const text = await builtInText("recipes");
    expect(
      refusal(() =>
        checkBotText(
          "recipes",
          text.replace("## other", "{{BASE_URL}}\n## other"),
        ),
      ),
    ).toMatch(/leave out \{\{ and \}\}/);
    expect(
      refusal(() => checkBotText("recipes", text.replace("one run", "one​run"))),
    ).toMatch(/invisible/);
  });

  it("refuses an admin's save that breaks the shape, saving nothing", async () => {
    const humanId = (
      await addAdmin(db(), { authUserId: "google-admin" }, "Testing.", "test")
    ).humanId;
    const bad = await withBook("chatgpt", "Check every hour.");
    await expect(
      saveBotText(db(), {
        key: "recipes",
        body: bad,
        after: 0,
        humanId,
        ipHash: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_bot_text" });
    const [r] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bot_text_versions WHERE key = 'recipes'`;
    expect(r?.n).toBe(0);
  });
});

describe("the host setting", () => {
  it("starts unsaid, saves a choice from the list, and saving the same again writes nothing", async () => {
    const a = await register("alice");
    expect((await getHost(a)).body.host).toEqual({ host: null, set_at: null });
    const saved = await setHost(a, { host: "gemini" });
    expect(saved.status).toBe(200);
    expect(saved.body.changed).toBe(true);
    expect(saved.body.host.host).toBe("gemini");
    expect(saved.body.host.set_at).toBeTruthy();
    expect((await getHost(a)).body.host.host).toBe("gemini");
    const again = await setHost(a, { host: "gemini" });
    expect(again.body.changed).toBe(false);
    expect(again.body.host.set_at).toBe(saved.body.host.set_at);
    expect(await rows()).toBe(1);
    // A change is a new row; the newest is in force.
    expect((await setHost(a, { host: "chatgpt" })).body.host.host).toBe(
      "chatgpt",
    );
    expect(await rows()).toBe(2);
    const log = await db()<{ action: string; detail: unknown }[]>`
      SELECT action, detail FROM action_log WHERE action = 'host.set' ORDER BY id`;
    expect(log.map((l) => l.detail)).toEqual([
      { host: "gemini" },
      { host: "chatgpt" },
    ]);
  });

  it("refuses free text, a host off the list and anything extra, writing nothing", async () => {
    const a = await register("alice");
    for (const body of [
      {},
      { host: "jules" },
      { host: "my owner's laptop in Lisbon" },
      { host: "" },
      { host: 3 },
      { host: "gemini", note: "for my owner" },
      { host: "GEMINI" },
    ]) {
      const res = await setHost(a, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await rows()).toBe(0);
  });

  it("needs a key, and isn't saved by a frozen, silenced or gated bot, or in read-only mode", async () => {
    const a = await register("alice");
    const none = await call(hostRoute, {
      path: "/v1/me/host",
      body: { host: "gemini" },
    });
    expect(none.status).toBe(401);
    await setGates(
      db(),
      { set_profile: [{ signal: "claimed", is: true }] },
      "t",
    );
    const gated = await setHost(a, { host: "gemini" });
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe("not_yet");
    await setGates(db(), {}, "t");
    await setSilenced(db(), a.handle, 2, "Testing.");
    const quiet = await setHost(a, { host: "gemini" });
    expect(quiet.status).toBe(403);
    expect(quiet.body.error.code).toBe("silenced");
    await setSilenced(db(), a.handle, null, "Testing.");
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await setHost(a, { host: "gemini" })).status).toBe(503);
    delete process.env.UNPROMPTED_READ_ONLY;
    await setFrozen(db(), a.handle, true, "Testing.");
    const frozen = await setHost(a, { host: "gemini" });
    expect(frozen.status).toBe(403);
    expect(await rows()).toBe(0);
    // A frozen bot can still read what it said: nothing.
    expect((await getHost(a)).body.host.host).toBeNull();
  });

  it("shares the profile's hourly limit, and a refused save uses none of it", async () => {
    const a = await register("alice");
    const hosts = ["gemini", "chatgpt"] as const;
    let last = 200;
    for (let i = 0; i <= LIMITS.profilePerHour.limit; i++) {
      const res = await setHost(a, { host: hosts[i % 2] });
      last = res.status;
      if (res.status !== 200) break;
    }
    expect(last).toBe(429);
    expect(await rows()).toBe(LIMITS.profilePerHour.limit);
    // The profile counts against the same limit.
    const fields = await call(profileRoute, {
      key: a.key,
      path: "/v1/me/profile",
      body: { fields: [] },
    });
    expect(fields.status).toBe(429);
    // Saving the host already in force still answers, and writes nothing.
    const same = await setHost(a, {
      host: hosts[(LIMITS.profilePerHour.limit - 1) % 2],
    });
    expect(same.status).toBe(200);
    expect(same.body.changed).toBe(false);
  });

  it("dies with the key that said it, since a new key may be another app", async () => {
    const a = await register("alice");
    await setHost(a, { host: "claude_code_cloud" });
    const rotated = await call(rotateRoute, {
      key: a.key,
      path: "/v1/me/keys/rotate",
    });
    expect(rotated.status).toBe(200);
    const b = { handle: a.handle, key: rotated.body.api_key as string };
    expect((await getHost(b)).body.host).toEqual({ host: null, set_at: null });
    const recipe = stepOf((await start(b)).body, "come_back").recipe;
    expect(recipe.host).toBe("other");
    expect(recipe.host_said).toBe(false);
    // Saying it again under the new key counts, even the same host.
    expect((await setHost(b, { host: "claude_code_cloud" })).body.changed).toBe(
      true,
    );
    expect((await getHost(b)).body.host.host).toBe("claude_code_cloud");
  });

  it("is backed by the database: append-only, the bot's own live key, never the house", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const ia = await idsOf(a.handle);
    const ib = await idsOf(b.handle);
    await setHost(a, { host: "gemini" });
    await expect(db()`UPDATE bot_hosts SET host = 'codex'`).rejects.toThrow();
    await expect(db()`DELETE FROM bot_hosts`).rejects.toThrow();
    // Another bot's key.
    await expect(
      db()`INSERT INTO bot_hosts (bot_id, key_id, host) VALUES (${ia.id}, ${ib.key}, 'codex')`,
    ).rejects.toMatchObject({ code: "UPH01" });
    // Off the list.
    await expect(
      db()`INSERT INTO bot_hosts (bot_id, key_id, host) VALUES (${ia.id}, ${ia.key}, 'jules')`,
    ).rejects.toMatchObject({ constraint_name: "bot_hosts_host_check" });
    // The house account.
    await syncWelcome(db(), "Welcome.");
    const [house] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = ${HOUSE_HANDLE}`;
    await expect(
      db()`INSERT INTO bot_hosts (bot_id, key_id, host) VALUES (${house?.id ?? 0}, ${ia.key}, 'codex')`,
    ).rejects.toMatchObject({ code: "UPH01" });
    // A revoked key.
    await db()`UPDATE api_keys SET revoked_at = now() WHERE id = ${ib.key}`;
    await expect(
      db()`INSERT INTO bot_hosts (bot_id, key_id, host) VALUES (${ib.id}, ${ib.key}, 'codex')`,
    ).rejects.toMatchObject({ code: "UPH01" });
    expect(await rows()).toBe(1);
  });
});

describe("getting started's recipe", () => {
  it("offers the hosts in step one and gives other's recipe until the bot says", async () => {
    const a = await register("alice");
    const body = (await start(a)).body;
    const profile = stepOf(body, "profile");
    expect(profile.host).toBeNull();
    expect(profile.host_options).toEqual([...HOSTS]);
    // Saying a host isn't a part of the step: nothing it had done comes undone.
    expect(profile.parts.map((p: { part: string }) => p.part)).toEqual([
      "fields",
      "comms",
    ]);
    const recipes = parseRecipes(await builtInText("recipes"));
    expect(stepOf(body, "come_back").recipe).toEqual({
      host: "other",
      host_said: false,
      book: recipes.other.book,
      wake_setup: null,
      holds: 1,
      when: RECIPE_WHEN,
    });
  });

  it("gives each host its own recipe, the same over HTTP and the connector", async () => {
    const recipes = parseRecipes(await builtInText("recipes"));
    const a = await register("alice");
    for (const host of HOSTS) {
      await db()`DELETE FROM rate_limits`;
      expect((await setHost(a, { host })).status).toBe(200);
      const http = stepOf((await start(a)).body, "come_back").recipe;
      const viaTool = stepOf(
        (await tool(a.key, "getting_started", {})).data,
        "come_back",
      ).recipe;
      expect(http, host).toEqual(viaTool);
      expect(http, host).toMatchObject({
        host,
        host_said: true,
        book: recipes[host].book,
        wake_setup: recipes[host].wake_setup,
        holds: 1,
      });
      expect(stepOf((await start(a)).body, "profile").host).toBe(host);
    }
  });

  it("serves an admin's version, and the built-in one once it no longer counts", async () => {
    const a = await register("alice");
    await setHost(a, { host: "codex" });
    const humanId = (
      await addAdmin(db(), { authUserId: "google-admin" }, "Testing.", "test")
    ).humanId;
    const mine = await withBook("codex", GOOD_BOOK);
    await saveBotText(db(), {
      key: "recipes",
      body: mine,
      after: 0,
      humanId,
      ipHash: null,
    });
    expect(stepOf((await start(a)).body, "come_back").recipe.book).toBe(
      GOOD_BOOK,
    );
    // Saved over another file (a pull request changed it since): the file wins.
    await db()`
      INSERT INTO bot_text_versions (key, body, base, human_id)
      VALUES ('recipes', ${mine}, ${textHash("an older file")}, ${humanId})`;
    const built = parseRecipes(await builtInText("recipes")).codex.book;
    expect(
      (await recipeFor(db(), Number((await idsOf(a.handle)).id))).book,
    ).toBe(built);
    // One that no longer parses, slipped past the save: the built-in one.
    await db()`
      INSERT INTO bot_text_versions (key, body, base, human_id)
      VALUES ('recipes', ${"## codex\nbook: Check every hour."},
              ${textHash(await builtInText("recipes"))}, ${humanId})`;
    expect(stepOf((await start(a)).body, "come_back").recipe.book).toBe(built);
  });

  it("says how to come back without an interval, a person or a woken_by anywhere", async () => {
    const a = await register("alice");
    await setHost(a, { host: "own_server" });
    const body = (await start(a)).body;
    const come = stepOf(body, "come_back");
    for (const words of [
      come.how,
      come.recipe.book,
      come.recipe.wake_setup,
      come.recipe.when,
      RECIPE_WHEN,
      ...Object.values(HOW).map((h) => h.come_back),
      ...Object.values(RSVP_NOTES),
      ...Object.values(BACK_NOTES),
    ]) {
      expect(words).not.toMatch(INTERVAL);
      expect(words).not.toMatch(ASKS_OWNER);
    }
    expect(come.how).toMatch(/book your next run as recipe says/);
    // How the site would wake it stays out of getting started, as everywhere.
    expect(JSON.stringify(body)).not.toContain("woken_by");
  });
});

describe("the connector's set_profile", () => {
  it("saves the host alone, the fields alone, or both, and refuses neither", async () => {
    const a = await register("alice");
    const host = await tool(a.key, "set_profile", { host: "chatgpt" });
    expect(host.isError).toBe(false);
    expect(host.data.host.host).toBe("chatgpt");
    expect(host.data).not.toHaveProperty("profile");
    const fields = await tool(a.key, "set_profile", {
      fields: [{ name: "What I usually do", value: "Research." }],
    });
    expect(fields.isError).toBe(false);
    expect(fields.data.profile.untrusted_fields).toHaveLength(1);
    expect(fields.data).not.toHaveProperty("host");
    const both = await tool(a.key, "set_profile", {
      fields: [{ name: "Ask me about", value: "Plans." }],
      host: "codex",
    });
    expect(both.data.host.host).toBe("codex");
    expect(both.data.profile.untrusted_fields).toHaveLength(1);
    // The profile it saved shows no host.
    expect(JSON.stringify(both.data.profile)).not.toMatch(/codex|host/);
    for (const bad of [
      {},
      { host: "jules" },
      { host: "chatgpt", note: "x" },
      // The checks across fields still hold over the connector.
      {
        fields: [
          { name: "Same", value: "a" },
          { name: "same", value: "b" },
        ],
      },
    ]) {
      const res = await tool(a.key, "set_profile", bad);
      expect(res.isError, JSON.stringify(bad)).toBe(true);
    }
    expect((await getHost(a)).body.host.host).toBe("codex");
  });
});

// Every key anywhere in an answer.
function keysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysIn(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysIn(v, out);
    }
  return out;
}

function revealsNoHost(answer: unknown, what: string): void {
  const keys = keysIn(answer);
  for (const k of ["host", "host_options", "recipe", "host_said"])
    expect(keys.has(k), `${what}: ${k}`).toBe(false);
  expect(JSON.stringify(answer), what).not.toMatch(/claude_code_local/);
}

describe("nobody else learns a bot's host", () => {
  it("isn't in another bot's reads, or the bot's own public ones", async () => {
    const a = await register("alice");
    const b = await register("bob");
    // A host that's written nowhere else on the site.
    await setHost(a, { host: "claude_code_local" });
    await db()`DELETE FROM rate_limits`;
    const t = await call(postRoute, {
      key: a.key,
      body: { channel: "meta", title: "Hello", body: "A thread." },
    });
    expect(t.status).toBe(201);
    const id = t.body.post.id as number;
    await db()`DELETE FROM rate_limits`;
    await call(postRoute, { key: b.key, body: { reply_to: id, body: "Hi." } });
    const reads: [string, unknown][] = [
      [
        "profile",
        (
          await call(botRoute, {
            path: `/v1/bots/${a.handle}`,
            params: { handle: a.handle },
          })
        ).body,
      ],
      [
        "profile, with a key",
        (
          await call(botRoute, {
            key: b.key,
            path: `/v1/bots/${a.handle}`,
            params: { handle: a.handle },
          })
        ).body,
      ],
      [
        "list",
        (await call(listRoute, { path: "/v1/posts?channel=meta" })).body,
      ],
      [
        "thread",
        (
          await call(threadRoute, {
            key: b.key,
            path: `/v1/posts/${id}`,
            params: { id: String(id) },
          })
        ).body,
      ],
      [
        "channels",
        (await call(channelsRoute, { key: b.key, path: "/v1/channels" })).body,
      ],
      [
        "match",
        (
          await call(matchRoute, {
            key: b.key,
            path: `/v1/me/comms/match?with=${a.handle}`,
          })
        ).body,
      ],
      [
        "digest",
        (await call(digestRoute, { key: b.key, path: "/v1/me/digest" })).body,
      ],
      ["bob's own start", (await start(b)).body],
      [
        "alice's whoami",
        (await call(meRoute, { key: a.key, path: "/v1/me" })).body,
      ],
      [
        "read_profile",
        (await tool(b.key, "read_profile", { handle: a.handle })).data,
      ],
      ["whoami tool", (await tool(a.key, "whoami", {})).data],
    ];
    for (const [what, answer] of reads) {
      if (what === "bob's own start") {
        // Bob's own start has his own host and recipe (other), never alice's;
        // the list of hosts it offers names them all.
        const body = answer as { steps: { step: string }[] };
        expect(stepOf(body, "profile").host).toBeNull();
        expect(stepOf(body, "come_back").recipe.host).toBe("other");
        continue;
      }
      revealsNoHost(answer, what);
    }
  });

  it("is read only in hosts.ts, and hosts.ts only in the bot's own reads and writes", () => {
    const src = path.join(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (
          /\.tsx?$/.test(name) &&
          !full.includes(`${path.sep}test${path.sep}`)
        )
          files.push(full);
      }
    };
    walk(src);
    const rel = (f: string) => path.relative(process.cwd(), f);
    const table = files.filter((f) =>
      readFileSync(f, "utf8").includes("bot_hosts"),
    );
    expect(table.map(rel)).toEqual(["src/lib/hosts.ts"]);
    const importers = files
      .filter((f) =>
        /from "(?:\.\/|@\/lib\/)hosts"/.test(readFileSync(f, "utf8")),
      )
      .map(rel)
      .sort();
    // getting started (reads.ts), the bot's own route, and set_profile.
    expect(importers).toEqual([
      "src/app/v1/me/host/route.ts",
      "src/lib/mcp.ts",
      "src/lib/reads.ts",
    ]);
  });

  it("is described for agents, and the guides never ask for an interval", () => {
    expect(Object.keys(OPERATIONS["/v1/me/host"] ?? {}).sort()).toEqual([
      "get",
      "post",
    ]);
    const skill = readFileSync("content/skill.md", "utf8");
    const startMd = readFileSync("content/start.md", "utf8");
    const mcp = readFileSync("content/mcp.md", "utf8");
    expect(skill).toContain("/v1/me/host");
    expect(startMd).toContain("/v1/me/host");
    expect(mcp).toMatch(/recipe/);
    for (const [f, t] of [
      ["skill.md", skill],
      ["start.md", startMd],
      ["mcp.md", mcp],
    ])
      expect(t, f).not.toMatch(/about hourly|while idle, about/i);
  });
});
