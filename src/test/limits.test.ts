import { beforeEach, describe, expect, it } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as post } from "@/app/v1/posts/route";
import { db } from "@/lib/db";
import { SPIKE } from "@/lib/floods";
import { networkOf } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { awayFromWindowEdge, call, register, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  await awayFromWindowEdge();
});

async function count(table: "posts" | "bots" | "action_log"): Promise<number> {
  const [r] = await db().unsafe(`SELECT count(*)::int AS n FROM ${table}`);
  return r?.n as number;
}

describe("rate limits", () => {
  it("allows one post a minute and says when to retry", async () => {
    const a = await register("alice");
    expect(
      (await call(post, { key: a.key, body: { channel: "meta", body: "one" } }))
        .status,
    ).toBe(201);
    const second = await call(post, {
      key: a.key,
      body: { channel: "meta", body: "two" },
    });
    expect(second.status).toBe(429);
    const retry = Number(second.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(await count("posts")).toBe(1);
    expect(await count("action_log")).toBe(2);
  });

  it("does not use up quota on a request that fails for another reason", async () => {
    const a = await register("alice");
    expect(
      (await call(post, { key: a.key, body: { channel: "nope", body: "x" } }))
        .status,
    ).toBe(404);
    expect(
      (await call(post, { key: a.key, body: { channel: "meta", body: "x" } }))
        .status,
    ).toBe(201);
  });

  it("limits each bot separately", async () => {
    const [a, b] = [await register("alice"), await register("bob")];
    expect(
      (await call(post, { key: a.key, body: { channel: "meta", body: "a" } }))
        .status,
    ).toBe(201);
    expect(
      (await call(post, { key: b.key, body: { channel: "meta", body: "b" } }))
        .status,
    ).toBe(201);
  });

  it("allows three registrations an hour from one address", async () => {
    const ip = "203.0.113.7";
    for (const h of ["one", "two", "three"]) {
      expect(
        (await call(registerRoute, { ip, body: { handle: `bot-${h}` } }))
          .status,
      ).toBe(201);
    }
    const fourth = await call(registerRoute, {
      ip,
      body: { handle: "bot-four" },
    });
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("retry-after")).toBeTruthy();
    expect(await count("bots")).toBe(3);
    expect(
      (
        await call(registerRoute, {
          ip: "203.0.113.8",
          body: { handle: "bot-four" },
        })
      ).status,
    ).toBe(201);
  });

  it("caps new bots site-wide", async () => {
    await awayFromWindowEdge(3600);
    // As if the hour's other sign-ups came in slowly, without a spike.
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES ('register:all', to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${LIMITS.registerGlobal.limit - 1})`;
    await register("last-place");
    const res = await call(registerRoute, { body: { handle: "one-too-many" } });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toContain("whole site this hour");
    expect(await count("bots")).toBe(1);
  });

  it("caps a burst of sign-ups sooner (src/lib/floods.ts)", async () => {
    await awayFromWindowEdge(3600);
    let joined = 0;
    for (let i = 0; i < LIMITS.registerGlobal.limit; i++) {
      const res = await call(registerRoute, { body: { handle: `flood-${i}` } });
      if (res.status !== 201) {
        expect(res.status).toBe(429);
        expect(res.body.error.message).toContain("tightened");
        break;
      }
      joined += 1;
    }
    expect(joined).toBe(SPIKE.signUps + LIMITS.registerTightened.limit);
    expect(await count("bots")).toBe(joined);
  });

  it("holds the per-minute limit under concurrent posts", async () => {
    const a = await register("alice");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call(post, {
          key: a.key,
          body: { channel: "meta", body: `burst ${i}` },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
    expect(await count("posts")).toBe(1);
  });

  it("caps posts site-wide", async () => {
    await db()`INSERT INTO rate_limits (bucket, window_start, count)
      VALUES ('post:all', to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), 600)`;
    const a = await register("alice");
    expect(
      (await call(post, { key: a.key, body: { channel: "meta", body: "x" } }))
        .status,
    ).toBe(429);
  });
});

describe("network addresses", () => {
  it("counts IPv6 by /64 and unwraps mapped IPv4", () => {
    expect(networkOf("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkOf("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(networkOf("203.0.113.9")).toBe("203.0.113.9");
  });
});
