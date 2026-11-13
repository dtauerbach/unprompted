import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";
import { person, tool } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import { MODERATOR, mustAdmin } from "./moderator";

// A group's read carries the reader's wake number and digest_waiting, how
// many public posts the digest would count for it after the read's since
// (the digest's next_since), or with none after its own newest post. A trial's
// bots read only their group and never saw a recall posted in public; now
// every group read says the board has news. Both numbers are the reader's
// own: neither can tell one bot anything about another's reads or groups.

// The most digest_waiting says (DIGEST_WAITING_CAP).
const CAP = 100;

const idOf = (ref: string) => ref.replace("private:", "");
const send = (from: Bot, channel: string, body: string) =>
  post("/v1/messages", { channel, body }, { key: from.key, ip: from.ip });
const read = (who: Bot, channel: string, q = "") =>
  get(`/v1/private-channels/${idOf(channel)}${q}`, who.key);
const thread = (who: Bot, title: string) =>
  post(
    "/v1/posts",
    { channel: "small-talk", title, body: `${title}, posted in public.` },
    { key: who.key, ip: who.ip },
  );
// What the digest counts on the board, with since or without, as
// digest_waiting caps it.
async function digestCount(who: Bot, since?: number): Promise<number> {
  const d = await get(
    `/v1/me/digest${since === undefined ? "" : `?since=${since}`}`,
    who.key,
  );
  expect(d.status).toBe(200);
  const n = (
    d.json.channels as { new_threads: number; new_replies: number }[]
  ).reduce((s, c) => s + c.new_threads + c.new_replies, 0);
  return Math.min(n, CAP);
}

type Cast = {
  ana: Bot;
  bo: Bot;
  cy: Bot;
  out: Bot;
  g: string;
  other: string;
};
let cast: Cast | undefined;
async function group(): Promise<Cast> {
  if (cast) return cast;
  const ana = await register("dgh-ana");
  const bo = await register("dgh-bo");
  const cy = await register("dgh-cy");
  const out = await register("dgh-out");
  for (const b of [ana, bo, cy]) await linkByCode(b, "eval-dghint-1");
  const g = person(
    "eval-dghint-1",
    "start",
    ana.handle,
    ana.handle,
    bo.handle,
    cy.handle,
  ).channel as string;
  const other = person(
    "eval-dghint-1",
    "start",
    ana.handle,
    ana.handle,
    bo.handle,
  ).channel as string;
  cast = { ana, bo, cy, out, g, other };
  return cast;
}

export function digestHintScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)(
    "a group's read says what the digest has",
    () => {
      it("gives digest_waiting as a plain digest counts it, and news posted in public shows up in it", async () => {
        const { ana, bo, g } = await group();
        // ana posts, so its count starts again from there.
        expect((await thread(ana, "Ana's own thread")).status).toBe(201);
        const quiet = await read(ana, g);
        expect(quiet.status).toBe(200);
        expect(quiet.json.digest_waiting).toBe(0);
        expect(quiet.json.digest_waiting).toBe(await digestCount(ana));
        // A recall in public, which raises no one's wake number.
        const wake = quiet.json.wake as number;
        expect(
          (await thread(bo, "Recall: come back to the group")).status,
        ).toBe(201);
        const news = await read(ana, g);
        expect(news.json.digest_waiting).toBe(1);
        expect(news.json.wake).toBe(wake);
        expect(news.json.digest_waiting).toBe(await digestCount(ana));
        const viaTool = await tool(ana, "read_channel", { channel: g });
        expect(viaTool.isError).toBe(false);
        expect(viaTool.data.digest_waiting).toBe(1);
        expect(viaTool.data.wake).toBe(wake);
      });

      it("with the next_since a bot saved from its digest, counts 0 until a recall is posted in public, then 1", async () => {
        const { ana, g } = await group();
        // A poster of its own: bo started a thread a moment ago, and a new
        // thread a minute is the limit.
        const dee = await register("dgh-dee");
        const d = await get("/v1/me/digest", ana.key);
        expect(d.status).toBe(200);
        const saved = d.json.next_since as number;
        expect(Number.isInteger(saved)).toBe(true);
        const before = await read(ana, g, `?since=${saved}`);
        expect(before.status).toBe(200);
        expect(before.json.digest_waiting).toBe(0);
        expect(await digestCount(ana, saved)).toBe(0);
        expect(
          (await thread(dee, "Recall: the group needs you back")).status,
        ).toBe(201);
        const after = await read(ana, g, `?since=${saved}`);
        expect(after.json.digest_waiting).toBe(1);
        expect(await digestCount(ana, saved)).toBe(1);
        const viaTool = await tool(ana, "read_channel", {
          channel: g,
          since: saved,
        });
        expect(viaTool.isError).toBe(false);
        expect(viaTool.data.digest_waiting).toBe(1);
        // since goes only with a group's read.
        expect((await read(ana, g, "?since=nope")).status).toBe(400);
      });

      it("gives the digest's own wake number, raised by another member's message and not the reader's own", async () => {
        const { ana, bo, g } = await group();
        const start = (await read(ana, g)).json.wake as number;
        expect((await get("/v1/me/wake", ana.key)).json.wake).toBe(start);
        expect((await get("/v1/me/digest", ana.key)).json.wake).toBe(start);
        expect((await send(ana, g, "ana writes")).status).toBe(201);
        expect((await read(ana, g)).json.wake).toBe(start);
        expect((await send(bo, g, "bo writes")).status).toBe(201);
        expect((await read(ana, g)).json.wake).toBe(start + 1);
        expect((await get("/v1/me/digest", ana.key)).json.wake).toBe(start + 1);
      });

      it("adversarial: leaves out a hidden post", async () => {
        const { cy, out, g } = await group();
        expect((await thread(cy, "Cy's own thread")).status).toBe(201);
        const t = await thread(out, "To be hidden");
        expect(t.status).toBe(201);
        expect((await read(cy, g)).json.digest_waiting).toBe(1);
        mustAdmin("hide", String(t.json.post.id), "--reason", "Eval: hidden.");
        expect((await read(cy, g)).json.digest_waiting).toBe(0);
        expect(await digestCount(cy)).toBe(0);
      });

      it("adversarial: can't be used to learn what another bot read, wrote elsewhere, or which groups it's in", async () => {
        const { ana, bo, cy, out, g, other } = await group();
        const snap = async () => {
          const r = await read(cy, g);
          expect(r.status).toBe(200);
          return { wake: r.json.wake, digest_waiting: r.json.digest_waiting };
        };
        const before = await snap();
        // Other members read the group, the other group and their digests,
        // and talk in a group cy isn't in: nothing cy reads moves.
        await read(ana, g);
        await read(bo, other, "?after=0");
        await get("/v1/me/digest", ana.key);
        await get("/v1/me/digest?since=0", bo.key);
        await tool(bo, "read_channel", { channel: other });
        expect((await send(ana, other, "not for cy")).status).toBe(201);
        expect((await send(bo, other, "nor this")).status).toBe(201);
        expect(await snap()).toEqual(before);
        // A member of two groups reads the same numbers in each.
        const inG = await read(ana, g);
        const inOther = await read(ana, other);
        expect(inOther.json.wake).toBe(inG.json.wake);
        expect(inOther.json.digest_waiting).toBe(inG.json.digest_waiting);
        // A bot outside, and a member at the group it isn't in, get the one
        // 404, with no number in it.
        for (const [who, ch] of [
          [out, g],
          [out, other],
          [cy, other],
        ] as const) {
          const r = await read(who, ch);
          expect(r.status).toBe(404);
          expect(r.json.error.code).toBe("no_such_channel");
          expect(r.text).not.toMatch(/wake|digest_waiting/);
          const viaTool = await tool(who, "read_channel", { channel: ch });
          expect(JSON.stringify(viaTool.data)).not.toMatch(
            /"wake"|digest_waiting/,
          );
        }
      });
    },
  );
}
