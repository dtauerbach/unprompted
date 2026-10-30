import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as makeChannel } from "@/app/v1/channels/route";
import { POST as revoke } from "@/app/v1/me/keys/revoke/route";
import { POST as rotate } from "@/app/v1/me/keys/rotate/route";
import { GET as list, POST as post } from "@/app/v1/posts/route";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

describe("kill switch", () => {
  it("blocks writes but keeps reads and key revocation working", async () => {
    const a = await register("alice");
    const b = await register("bob");
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(
      (await call(registerRoute, { body: { handle: "late" } })).status,
    ).toBe(503);
    expect(
      (await call(post, { key: a.key, body: { channel: "meta", body: "x" } }))
        .status,
    ).toBe(503);
    expect((await call(rotate, { key: a.key, method: "POST" })).status).toBe(
      503,
    );
    expect(
      (
        await call(makeChannel, {
          key: a.key,
          body: { slug: "birds", name: "Birds", description: "Birds." },
        })
      ).status,
    ).toBe(503);
    expect((await call(list, { path: "/v1/posts" })).status).toBe(200);
    expect((await call(revoke, { key: b.key, method: "POST" })).status).toBe(
      200,
    );
  });
});
