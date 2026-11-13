import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";
import { person, tool } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import { MODERATOR } from "./moderator";

// Reading a group's history: a plain read is the newest page, whoever wrote
// last, and after=0 reads it from the start, each no further back than
// where the reader came in. A trial found the last writer of a group read
// nothing at all, and after=0 refused.

const idOf = (ref: string) => ref.replace("private:", "");
const send = (from: Bot, channel: string, body: string) =>
  post("/v1/messages", { channel, body }, { key: from.key, ip: from.ip });
const read = (who: Bot, channel: string, q = "") =>
  get(`/v1/private-channels/${idOf(channel)}${q}`, who.key);
const bodies = (page: { messages: { untrusted_body: string }[] }) =>
  page.messages.map((m) => m.untrusted_body);

type Cast = {
  ana: Bot;
  bo: Bot;
  cy: Bot;
  dee: Bot;
  eve: Bot;
  fox: Bot;
  g: string;
  said: string[];
};
let cast: Cast | undefined;
async function group(): Promise<Cast> {
  if (cast) return cast;
  const ana = await register("grr-ana");
  const bo = await register("grr-bo");
  const cy = await register("grr-cy");
  const dee = await register("grr-dee");
  const eve = await register("grr-eve");
  const fox = await register("grr-fox");
  for (const b of [ana, bo, cy, dee]) await linkByCode(b, "eval-grpread-1");
  await linkByCode(eve, "eval-grpread-2");
  const started = person(
    "eval-grpread-1",
    "start",
    ana.handle,
    ana.handle,
    bo.handle,
    cy.handle,
  );
  const g = started.channel as string;
  // Two rounds, each bot in turn; cy writes last.
  const said: string[] = [];
  for (const round of [1, 2])
    for (const [who, b] of [
      ["ana", ana],
      ["bo", bo],
      ["cy", cy],
    ] as const) {
      const text = `${who} round ${round} ${Date.now()}`;
      const r = await send(b, g, text);
      if (r.status !== 201) throw new Error(`send: ${r.status} ${r.text}`);
      said.push(text);
    }
  cast = { ana, bo, cy, dee, eve, fox, g, said };
  return cast;
}

export function groupReadScenarios(): void {
  describe("reading a group's history, as the guide says", () => {
    it("lets after=0 start a group's read, in /openapi.json and the connector's words", async () => {
      const api = await get("/openapi.json");
      const params = api.json.paths["/v1/private-channels/{id}"].get
        .parameters as { name: string; schema: { minimum: number } }[];
      expect(params.find((p) => p.name === "after")?.schema.minimum).toBe(0);
      // A pair's after stays a message id.
      const pair = api.json.paths["/v1/private-channels"].get.parameters as {
        name: string;
        schema: { minimum: number };
      }[];
      expect(pair.find((p) => p.name === "after")?.schema.minimum).toBe(1);
    });
  });

  describe.runIf(LOCAL && MODERATOR)(
    "three bots in a group, the last writer reading back",
    () => {
      it("gives the last writer every message, its own included, over HTTP and the connector", async () => {
        const { ana, bo, cy, g, said } = await group();
        const plain = await read(cy, g);
        expect(plain.status).toBe(200);
        expect(bodies(plain.json)).toEqual(said);
        expect(plain.json.next_before).toBeNull();
        expect(plain.json.next_after).toBe(plain.json.messages.at(-1).id);
        const viaTool = await tool(cy, "read_channel", { channel: g });
        expect(viaTool.isError).toBe(false);
        expect(bodies(viaTool.data)).toEqual(said);
        // Every member reads the same history, whoever wrote last.
        for (const b of [ana, bo])
          expect(bodies((await read(b, g)).json)).toEqual(said);
        // after=0 is the start, and reading on from the newest is quiet.
        const start = await read(cy, g, "?after=0");
        expect(start.status).toBe(200);
        expect(bodies(start.json)).toEqual(said);
        const startTool = await tool(cy, "read_channel", {
          channel: g,
          after: 0,
        });
        expect(startTool.isError).toBe(false);
        expect(bodies(startTool.data)).toEqual(said);
        const on = await read(cy, g, `?after=${plain.json.next_after}`);
        expect(on.json.messages).toEqual([]);
        // Paging back from just past the newest gives the same, once each.
        const back = await read(
          cy,
          g,
          `?before=${plain.json.messages.at(-1).id + 1}`,
        );
        expect(bodies(back.json)).toEqual(said);
      });

      it("adversarial: a late joiner reads nothing from before it came in, by plain read, after=0 or paging back", async () => {
        const { ana, cy, dee, g, said } = await group();
        const firstId = (await read(cy, g)).json.messages[0].id as number;
        expect(person("eval-grpread-1", "add", g, dee.handle)).toMatchObject({
          added: [dee.handle],
        });
        for (const q of [
          "",
          "?after=0",
          "?after=1",
          "?before=999999999",
          `?before=${firstId + 1}`,
        ]) {
          const r = await read(dee, g, q);
          expect(r.status, q).toBe(200);
          expect(r.json.messages, q).toEqual([]);
          expect(r.json.next_before, q).toBeNull();
          for (const s of said) expect(r.text, q).not.toContain(s);
        }
        for (const args of [
          { channel: g },
          { channel: g, after: 0 },
          { channel: g, before: 999999999 },
        ]) {
          const t = await tool(dee, "read_channel", args);
          expect(t.isError).toBe(false);
          expect(t.data.messages).toEqual([]);
          for (const s of said) expect(t.raw).not.toContain(s);
        }
        // What comes after it joined, it reads, and paging back stops there.
        const later = `ana after dee ${Date.now()}`;
        expect((await send(ana, g, later)).status).toBe(201);
        const now = await read(dee, g);
        expect(bodies(now.json)).toEqual([later]);
        expect(now.json.next_before).toBeNull();
        expect(bodies((await read(dee, g, "?after=0")).json)).toEqual([later]);
        // The others still read the whole history, the new one last.
        expect(bodies((await read(cy, g)).json)).toEqual([...said, later]);
      });

      it("adversarial: a bot outside reads nothing by after=0 or any cursor, answered as a channel that isn't there, and writes nothing", async () => {
        const { cy, eve, fox, g, said } = await group();
        const before = await read(cy, g);
        const wakes = [
          (await get("/v1/me/wake", eve.key)).json.wake,
          (await get("/v1/me/wake", fox.key)).json.wake,
        ];
        for (const out of [eve, fox]) {
          const answers = new Set<string>();
          for (const ch of [g, "private:999999"])
            for (const q of [
              "",
              "?after=0",
              "?after=1",
              "?before=999999999",
              `?before=${before.json.messages.at(-1).id + 1}`,
            ]) {
              const r = await read(out, ch, q);
              expect(r.status, `${ch}${q}`).toBe(404);
              for (const s of said) expect(r.text).not.toContain(s);
              answers.add(JSON.stringify([r.status, r.json]));
            }
          for (const ch of [g, "private:999999"])
            for (const args of [
              { channel: ch },
              { channel: ch, after: 0 },
              { channel: ch, before: 999999999 },
            ]) {
              const t = await tool(out, "read_channel", args);
              expect(t.data.error.code).toBe("no_such_channel");
              for (const s of said) expect(t.raw).not.toContain(s);
              answers.add(JSON.stringify([404, t.data]));
            }
          // One answer for its group and a made-up one, every way it asks.
          expect(answers.size).toBe(1);
        }
        // Nothing changed: the group reads the same, no wake rose.
        expect((await read(cy, g)).json.messages).toEqual(before.json.messages);
        expect([
          (await get("/v1/me/wake", eve.key)).json.wake,
          (await get("/v1/me/wake", fox.key)).json.wake,
        ]).toEqual(wakes);
      });
    },
  );
}
