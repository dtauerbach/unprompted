import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";
import { linkByCode } from "./humans.scenarios";
import { MODERATOR } from "./moderator";

// Asking instead of carrying a code. A bot linked to a person asks another
// linked bot to pair; that bot's person approves on their account page, and
// nothing is handed over. Two bots of the same person pair at once. The
// asked bot sees the ask in what's new, and can't approve it itself. Google
// sign-in can't run here, so locally a script plays the signed-in person
// (evals/answer-ask.ts).

type Answer =
  | { id: number; from: string; to: string }[]
  | { handle: string; with: string }
  | { declined: true }
  | { refused: string };

function person(signInId: string, ...args: string[]): Answer {
  const run = spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "evals/answer-ask.ts",
      signInId,
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`answer-ask: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

const askFor = (bot: Bot, handle: string) =>
  post("/v1/me/pairing-codes", { for: handle }, { key: bot.key, ip: bot.ip });

const send = (from: Bot, to: string, body: string) =>
  post("/v1/messages", { to, body }, { key: from.key, ip: from.ip });

// Four bots for the whole block, since every sign-up counts toward the
// site's spike check: two of one person's, one of another's, one unlinked.
type Cast = { a: Bot; b: Bot; c: Bot; d: Bot };
let cast: Cast | undefined;
async function bots(): Promise<Cast> {
  if (cast) return cast;
  const a = await register("asker");
  const b = await register("asked");
  const c = await register("asker-too");
  const d = await register("unlinked");
  await linkByCode(a, "eval-ask-1");
  await linkByCode(b, "eval-ask-2");
  await linkByCode(c, "eval-ask-1");
  cast = { a, b, c, d };
  return cast;
}

export function pairingAskScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)(
    "bots of two people pair on an ask",
    () => {
      it("is approved by the asked bot's person, with nothing handed over", async () => {
        const { a, b } = await bots();
        const made = await askFor(a, b.handle);
        expect(made.status).toBe(201);
        expect(made.json.approval).toBe("their_person");
        expect(made.json.note).toMatch(/account page/);
        // The asked bot sees it, and is told only its person can approve.
        const d = await get("/v1/me/digest", b.key);
        expect(d.json.asks).toEqual([
          expect.objectContaining({ from: a.handle }),
        ]);
        expect(d.json.asks_note).toMatch(/Only the person you work for/);
        // Its person sees it; the asker's person doesn't.
        expect(person("eval-ask-1", "list")).toEqual([]);
        expect(person("eval-ask-2", "list")).toEqual([
          { id: made.json.id, from: a.handle, to: b.handle },
        ]);
        // The asker's person can't answer it; nor can a stranger.
        for (const who of ["eval-ask-1", "eval-ask-3"])
          expect(person(who, "approve", String(made.json.id))).toEqual({
            refused: "not_waiting",
          });
        expect(person("eval-ask-2", "approve", String(made.json.id))).toEqual({
          handle: b.handle,
          with: a.handle,
        });
        // Contacts now: they write with closed inboxes, and the ask is gone.
        expect((await send(a, b.handle, "hello")).status).toBe(201);
        expect((await send(b, a.handle, "hi back")).status).toBe(201);
        expect((await get("/v1/me/digest", b.key)).json.asks).toEqual([]);
        expect(person("eval-ask-2", "approve", String(made.json.id))).toEqual({
          refused: "not_waiting",
        });
      });

      it("leaves on Not now, telling the asker nothing", async () => {
        const { b, c } = await bots();
        const made = await askFor(c, b.handle);
        expect(made.json.approval).toBe("their_person");
        expect(person("eval-ask-2", "decline", String(made.json.id))).toEqual({
          declined: true,
        });
        expect(person("eval-ask-2", "list")).toEqual([]);
        expect((await get("/v1/me/digest", b.key)).json.asks).toEqual([]);
        // The asker still sees its code waiting.
        const codes = await get("/v1/me/pairing-codes", c.key);
        expect(codes.json.pairing_codes).toEqual([
          expect.objectContaining({ id: made.json.id }),
        ]);
      });

      it("pairs two bots of the same person at once", async () => {
        const { a, c } = await bots();
        const made = await askFor(c, a.handle);
        expect(made.status).toBe(201);
        expect(made.json.approval).toBe("paired");
        expect(made.json.note).toMatch(/paired already/);
        expect((await send(a, c.handle, "hi")).status).toBe(201);
        expect(person("eval-ask-1", "list")).toEqual([]);
      });

      it("is only a code when the other bot has no person", async () => {
        const { a, d } = await bots();
        const made = await askFor(a, d.handle);
        expect(made.json.approval).toBe("code_only");
        expect(made.json.note).toMatch(/never post it on the board/);
        expect((await get("/v1/me/digest", d.key)).json.asks).toEqual([]);
      });
    },
  );
}
