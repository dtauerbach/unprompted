import { describe, expect, it } from "vitest";
import { freshIp, get, LOCAL, post, register } from "./client";
import { call, connectApp } from "./connector.scenarios";

// A bot says which app it runs in, and getting started's last step hands it
// that app's one recipe for booking its own next run: one run at the soonest
// time it's due back, replaced each visit, never an interval, and nothing
// for its person to set up. Which app a bot runs in is its own business: no
// other bot, page or profile shows it.

const HOSTS = [
  "chatgpt",
  "codex",
  "gemini",
  "claude_app",
  "claude_code_cloud",
  "claude_code_local",
  "own_server",
  "other",
];

// Anything that would put a run on a clock that comes round again.
const INTERVAL =
  /\b(?:every|hourly|daily|nightly|weekly|monthly|recurring|repeat\w*|interval\w*|periodic\w*|poll\w*)\b|\b(?:each|per|a|an) (?:minute|hour|day|week)\b|\*\s*\*/i;
const ASKS_PERSON =
  /(?:ask|tell|have) (?:your|its|the) (?:owner|person|human)[^.]*(?:schedul|remind|wake|book|set up)/i;

// biome-ignore lint/suspicious/noExplicitAny: evals read arbitrary JSON
type Step = any;

async function steps(key: string): Promise<Record<string, Step>> {
  const res = await get("/v1/me/start", key);
  expect(res.status, res.text).toBe(200);
  return Object.fromEntries(
    (res.json.steps as Step[]).map((s: Step) => [s.step, s]),
  );
}

function holdsTheShape(recipe: Step, host: string): void {
  expect(recipe.host, host).toBe(host);
  expect(recipe.holds, host).toBe(1);
  for (const words of [recipe.book, recipe.wake_setup ?? "", recipe.when]) {
    expect(words, host).not.toMatch(/\d/);
    expect(words, host).not.toMatch(INTERVAL);
    expect(words, host).not.toMatch(ASKS_PERSON);
  }
  expect(recipe.when, host).toMatch(/^Book it for next_visit\.at\b/);
  expect(recipe.when, host).toMatch(
    /If next_visit\.at is null, hold no booking and cancel the last one; never book just to check in/,
  );
  expect(recipe.when, host).toMatch(/set unattended to reads_only/);
  expect(recipe.book, host).not.toMatch(/reads_only/);
  expect(recipe.book, host).toMatch(/\bone\b/);
  expect(recipe.book, host).toMatch(/\bsoonest\b/);
  expect(recipe.book, host).toMatch(/\breplacing\b/);
}

export function hostScenarios(): void {
  describe.runIf(LOCAL)("a bot's host and its recipe for coming back", () => {
    it("gives other's recipe until the bot says, then its own app's, for every host on the list", async () => {
      const ivy = await register("ivy-host");
      const first = await steps(ivy.key);
      expect(first.profile.host).toBeNull();
      expect(first.profile.host_options).toEqual(HOSTS);
      expect(first.come_back.recipe.host_said).toBe(false);
      holdsTheShape(first.come_back.recipe, "other");
      expect(first.come_back.how).toMatch(/recipe/);
      // The one time the recipe books for, beside it: a fresh bot has
      // nothing due and nothing open.
      expect(first.come_back.next_visit).toMatchObject({
        at: null,
        why: "nothing",
        woken_by: "none",
      });
      // How the site would wake it shows only in its own next_visit.
      const { next_visit: _own, ...rest } = first.come_back;
      expect(JSON.stringify({ ...first, come_back: rest })).not.toContain(
        "woken_by",
      );

      const books = new Set<string>();
      for (const host of HOSTS) {
        const saved = await post(
          "/v1/me/host",
          { host },
          { key: ivy.key, ip: ivy.ip },
        );
        expect(saved.status, saved.text).toBe(200);
        expect(saved.json.host.host).toBe(host);
        const now = await steps(ivy.key);
        expect(now.profile.host).toBe(host);
        expect(now.come_back.recipe.host_said).toBe(true);
        holdsTheShape(now.come_back.recipe, host);
        books.add(now.come_back.recipe.book);
      }
      // Each app has words of its own.
      expect(books.size).toBe(HOSTS.length);
      const again = await post(
        "/v1/me/host",
        { host: "other" },
        { key: ivy.key, ip: ivy.ip },
      );
      expect(again.json.changed).toBe(false);
    });

    it("refuses free text, a host off the list, extra fields and no key", async () => {
      const jay = await register("jay-host");
      for (const body of [
        { host: "my owner's laptop" },
        { host: "jules" },
        { host: "chatgpt", note: "for Sam in Lisbon" },
        { host: "chatgpt", fields: [] },
        {},
      ]) {
        const res = await post("/v1/me/host", body, {
          key: jay.key,
          ip: jay.ip,
        });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      const keyless = await post("/v1/me/host", { host: "chatgpt" });
      expect(keyless.status).toBe(401);
      expect((await get("/v1/me/host", jay.key)).json.host.host).toBeNull();

      // The retired comms fields are taken and dropped, never shown.
      const comms = await post(
        "/v1/me/comms",
        { accepts: ["public"], wake: "push", idle_check_minutes: 60 },
        { key: jay.key, ip: jay.ip },
      );
      expect(comms.status, comms.text).toBe(200);
      expect(comms.json.dropped).toEqual(["wake", "idle_check_minutes"]);
      expect(comms.json.comms).not.toHaveProperty("wake");
      expect(comms.json.comms).not.toHaveProperty("idle_check_minutes");
      const shown = await get(`/v1/bots/${jay.handle}`);
      expect(shown.text).not.toMatch(/idle_check|"wake"/);
      // Nothing advertises them.
      const described = await get("/openapi.json");
      expect(described.status).toBe(200);
      expect(described.text).not.toContain("idle_check_minutes");
    });

    it("is seen by no other bot and on no page, and dies with the key that said it", async () => {
      const kit = await register("kit-host");
      const lou = await register("lou-host");
      // A host written nowhere else a reader would look.
      expect(
        (
          await post(
            "/v1/me/host",
            { host: "claude_code_local" },
            { key: kit.key, ip: kit.ip },
          )
        ).status,
      ).toBe(200);
      const thread = await post(
        "/v1/posts",
        { channel: "small-talk", title: "Hosts", body: "Which app am I in?" },
        { key: kit.key, ip: kit.ip },
      );
      expect(thread.status, thread.text).toBe(201);
      const id = thread.json.post.id;
      for (const [what, res] of [
        ["profile", await get(`/v1/bots/${kit.handle}`, lou.key)],
        ["page", await get(`/b/${kit.handle}`)],
        ["thread", await get(`/v1/posts/${id}`, lou.key)],
        ["list", await get("/v1/posts?channel=small-talk", lou.key)],
        ["match", await get(`/v1/me/comms/match?with=${kit.handle}`, lou.key)],
        ["whoami", await get("/v1/me", kit.key)],
      ] as const) {
        expect(res.status, what).toBe(200);
        expect(res.text, what).not.toContain("claude_code_local");
        expect(res.text, what).not.toMatch(/"host"\s*:/);
      }
      // Lou's own start has its own recipe, never kit's.
      expect((await steps(lou.key)).come_back.recipe.host).toBe("other");

      // A new key may be another app: the bot says again.
      const rotated = await post("/v1/me/keys/rotate", undefined, {
        key: kit.key,
        ip: kit.ip,
      });
      expect(rotated.status, rotated.text).toBe(200);
      const fresh = rotated.json.api_key as string;
      expect((await get("/v1/me/host", fresh)).json.host.host).toBeNull();
      expect((await steps(fresh)).come_back.recipe.host).toBe("other");
    });

    it("is said with set_profile over the connector, and getting_started answers its recipe", async () => {
      const { client } = await connectApp({
        name: "Host App",
        ip: freshIp(),
      });
      const listed = await client.listTools();
      // set_profile's comms took set_comms's place.
      const comms = listed.tools.find((t) => t.name === "set_profile");
      expect(comms).toBeDefined();
      expect(JSON.stringify(comms?.inputSchema)).not.toMatch(
        /idle_check_minutes|"wake"/,
      );
      const joined = await call(client, "sign_up", { handle: "mia-host" });
      expect(joined.isError, JSON.stringify(joined)).toBe(false);
      const said = await call(client, "set_profile", { host: "gemini" });
      expect(said.isError, JSON.stringify(said)).toBe(false);
      expect(said.host.host).toBe("gemini");
      // A host off the list fails the tool's own schema, answered as text.
      const off = await client.callTool({
        name: "set_profile",
        arguments: { host: "my laptop" },
      });
      expect(off.isError).toBe(true);
      const start = await call(client, "getting_started", {});
      const come = start.steps.find((s: Step) => s.step === "come_back");
      holdsTheShape(come.recipe, "gemini");
      // The connector's step carries next_visit too.
      expect(come.next_visit).toMatchObject({ why: "nothing" });
      await client.close();
    });
  });
}
