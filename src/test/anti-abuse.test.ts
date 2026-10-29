import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as registerClientRoute } from "@/app/v1/oauth/register/route";
import { POST as report } from "@/app/v1/posts/[id]/report/route";
import { POST as post } from "@/app/v1/posts/route";
import { hidePost, setAntiAbuse, showAntiAbuse } from "@/lib/admin";
import { approve } from "@/lib/connector";
import { db } from "@/lib/db";
import { TIGHTENED_UNTIL } from "@/lib/floods";
import { hashIp } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import {
  ANTI_ABUSE,
  ANTI_ABUSE_DEFAULTS,
  ANTI_ABUSE_NAMES,
  type AntiAbuse,
  antiAbuse,
  resolveAntiAbuse,
} from "@/lib/settings";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// The anti-abuse numbers come from the settings table, with public defaults
// for tests and local runs (src/lib/settings.ts). The values used below are
// test values, picked only to differ from the defaults.

beforeEach(async () => {
  await resetDb();
  await awayFromWindowEdge(3600);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function setRow(value: unknown) {
  const json = JSON.stringify(value);
  await db()`
    INSERT INTO settings (key, value) VALUES (${ANTI_ABUSE}, ${json}::text::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

async function count(table: string): Promise<number> {
  const [r] = await db().unsafe(`SELECT count(*)::int AS n FROM ${table}`);
  return r?.n as number;
}

async function bucket(name: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits WHERE bucket = ${name}`;
  return r?.n ?? 0;
}

async function botId(handle: string): Promise<string> {
  const [b] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return b?.id ?? "";
}

function warnings() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

function fallbackLines(warn: ReturnType<typeof warnings>) {
  return warn.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('"settings_fallback"'));
}

// A refusal's message, without the wait it gives, has no digits at all, so
// it can't be carrying a cap.
function expectNoNumber(res: { body: unknown; headers: Headers }) {
  const text = JSON.stringify(res.body).replace(/Try again in \d+ seconds/, "");
  expect(text).not.toMatch(/\d/);
  expect([...res.headers.keys()].sort()).not.toContain("x-ratelimit-limit");
}

const SOME: Partial<AntiAbuse> = {
  register_per_ip: 4,
  post_global: 41,
  new_bot_hours: 5,
};

describe("reading the anti-abuse numbers", () => {
  it("uses the defaults when there's no row, without a warning in tests", async () => {
    const warn = warnings();
    expect(await antiAbuse(db())).toEqual(ANTI_ABUSE_DEFAULTS);
    expect(fallbackLines(warn)).toEqual([]);
  });

  it("warns once when the row is missing in production, naming no value", () => {
    const warn = warnings();
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(resolveAntiAbuse(undefined, false)).toEqual(ANTI_ABUSE_DEFAULTS);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fallbackLines(warn).map((l) => JSON.parse(l))).toEqual([
      { event: "settings_fallback", key: ANTI_ABUSE, problem: "missing" },
    ]);
  });

  it("reads every number from the row when it's there", async () => {
    const all = Object.fromEntries(
      ANTI_ABUSE_NAMES.map((n) => [n, ANTI_ABUSE_DEFAULTS[n] + 1]),
    ) as AntiAbuse;
    await setRow(all);
    const warn = warnings();
    expect(await antiAbuse(db())).toEqual(all);
    expect(fallbackLines(warn)).toEqual([]);
  });

  it("falls back for each bad number on its own, with one warning line", async () => {
    await setRow({
      register_per_ip: 4,
      register_global: "lots",
      report_per_hour: 0,
      client_per_ip: 2.5,
      approve_global: 99_999_999,
      spike_sign_ups: null,
      surprise: 77,
    });
    const warn = warnings();
    const got = await antiAbuse(db());
    expect(got).toEqual({ ...ANTI_ABUSE_DEFAULTS, register_per_ip: 4 });
    const lines = fallbackLines(warn);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] as string);
    expect(line).toMatchObject({
      event: "settings_fallback",
      problem: "invalid",
    });
    expect(line.fields.sort()).toEqual(
      [
        "approve_global",
        "client_per_ip",
        "register_global",
        "report_per_hour",
        "spike_sign_ups",
        "surprise",
      ].sort(),
    );
    // Names only, never what was in the row.
    expect(lines[0]).not.toMatch(/lots|77|2\.5|99999999/);
  });

  it("falls back for everything when the row isn't an object, and never throws", async () => {
    for (const value of ["garbage", 12, [1, 2], null, true]) {
      await setRow(value);
      const warn = warnings();
      expect(await antiAbuse(db())).toEqual(ANTI_ABUSE_DEFAULTS);
      expect(fallbackLines(warn)).toHaveLength(1);
      vi.restoreAllMocks();
    }
  });

  it("keeps a write working with a malformed row, on the defaults", async () => {
    await setRow("garbage");
    const warn = warnings();
    expect(
      (await call(registerRoute, { body: { handle: "fine" } })).status,
    ).toBe(201);
    expect(fallbackLines(warn).length).toBeGreaterThan(0);
  });

  it("agrees with the database on the setting's name and the new-bot ranges", async () => {
    const [fn] = await db()<{ src: string }[]>`
      SELECT prosrc AS src FROM pg_proc WHERE proname = 'anti_abuse_number'`;
    expect(fn?.src).toContain(`'${ANTI_ABUSE}'`);
    const [isNew] = await db()<{ src: string }[]>`
      SELECT prosrc AS src FROM pg_proc WHERE proname = 'bot_is_new'`;
    expect(isNew?.src).toContain(
      `'new_bot_hours', ${ANTI_ABUSE_DEFAULTS.new_bot_hours}, 1, 720`,
    );
    expect(isNew?.src).toContain(
      `'new_bot_hidden_days', ${ANTI_ABUSE_DEFAULTS.new_bot_hidden_days}, 1, 90`,
    );
  });

  it("keeps the public defaults as LIMITS, for tests and local runs", () => {
    expect(LIMITS.registerPerIp.limit).toBe(
      ANTI_ABUSE_DEFAULTS.register_per_ip,
    );
    expect(LIMITS.registerGlobal.limit).toBe(
      ANTI_ABUSE_DEFAULTS.register_global,
    );
    expect(LIMITS.registerTightened.limit).toBe(
      ANTI_ABUSE_DEFAULTS.register_tightened,
    );
    expect(LIMITS.postGlobal.limit).toBe(ANTI_ABUSE_DEFAULTS.post_global);
    expect(LIMITS.reportPerHour.limit).toBe(
      ANTI_ABUSE_DEFAULTS.report_per_hour,
    );
  });
});

describe("a tighter setting refuses the next write, writing nothing", () => {
  it("registrations from one address", async () => {
    await setRow({ register_per_ip: 1 });
    const ip = freshIp();
    expect(
      (await call(registerRoute, { ip, body: { handle: "first" } })).status,
    ).toBe(201);
    const refused = await call(registerRoute, {
      ip,
      body: { handle: "second" },
    });
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toContain(
      "too many new bots from one address this hour",
    );
    expectNoNumber(refused);
    expect(await count("bots")).toBe(1);
    expect(await bucket(`register:ip:${hashIp(ip)}`)).toBe(1);
    expect(await bucket("register:all")).toBe(1);
  });

  it("registrations across the site", async () => {
    await setRow({ register_global: 2 });
    await register("one");
    await register("two");
    const refused = await call(registerRoute, { body: { handle: "three" } });
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toContain("whole site this hour");
    expectNoNumber(refused);
    expect(await count("bots")).toBe(2);
    expect(await bucket("register:all")).toBe(2);
  });

  it("registrations while tightened", async () => {
    await setRow({ register_tightened: 1 });
    await db()`
      INSERT INTO settings (key, value)
      VALUES (${TIGHTENED_UNTIL}, to_jsonb(now() + interval '1 hour'))`;
    await register("one");
    const refused = await call(registerRoute, { body: { handle: "two" } });
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toContain("tightened");
    expectNoNumber(refused);
    expect(await count("bots")).toBe(1);
    expect(await bucket("register:tight")).toBe(1);
  });

  it("posts across the site", async () => {
    await setRow({ post_global: 1 });
    const a = await register("alice");
    const b = await register("bob");
    expect(
      (await call(post, { key: a.key, body: { channel: "meta", body: "a" } }))
        .status,
    ).toBe(201);
    const refused = await call(post, {
      key: b.key,
      body: { channel: "meta", body: "b" },
    });
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toContain("whole site this hour");
    expectNoNumber(refused);
    expect(await count("posts")).toBe(1);
    expect(await bucket("post:all")).toBe(1);
  });

  it("reports", async () => {
    await setRow({ report_per_hour: 1 });
    const a = await register("alice");
    const b = await register("bob");
    const id = (
      await call(post, { key: a.key, body: { channel: "meta", body: "hi" } })
    ).body.post.id as number;
    const reportIt = () =>
      call(report, {
        key: b.key,
        path: `/v1/posts/${id}/report`,
        params: { id: String(id) },
        body: { reason: "spam" },
      });
    expect((await reportIt()).status).toBe(200);
    // Reporting the same post again still counts against the limit.
    const refused = await reportIt();
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toContain("too many reports");
    expectNoNumber(refused);
    expect(await count("reports")).toBe(1);
    expect(await bucket(`report:${await botId("bob")}`)).toBe(1);
  });

  it("connector apps from one address", async () => {
    await setRow({ client_per_ip: 1 });
    const ip = freshIp();
    const body = { redirect_uris: ["https://agent.example/cb"] };
    expect((await call(registerClientRoute, { ip, body })).status).toBe(201);
    const refused = await call(registerClientRoute, { ip, body });
    expect(refused.status).toBe(429);
    expect(JSON.stringify(refused.body)).toContain("connector apps");
    expectNoNumber(refused);
    expect(await count("oauth_clients")).toBe(1);
  });

  it("connector apps across the site", async () => {
    await setRow({ client_global: 1 });
    const body = { redirect_uris: ["https://agent.example/cb"] };
    expect((await call(registerClientRoute, { body })).status).toBe(201);
    const refused = await call(registerClientRoute, { body });
    expect(refused.status).toBe(429);
    expectNoNumber(refused);
    expect(await count("oauth_clients")).toBe(1);
  });

  it("agents allowed, from one address and across the site", async () => {
    const reg = await call(registerClientRoute, {
      body: { redirect_uris: ["https://agent.example/cb"] },
    });
    const params = () => ({
      response_type: "code",
      client_id: reg.body.client_id as string,
      redirect_uri: "https://agent.example/cb",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const ipHash = hashIp(freshIp());
    await setRow({ approve_per_ip: 1 });
    await approve(params(), null, ipHash, "http://unprompted.test");
    const perIp = approve(params(), null, ipHash, "http://unprompted.test");
    await expect(perIp).rejects.toMatchObject({ status: 429 });
    const err = await perIp.catch((e) => e);
    expect(err.message).toContain("from one address");
    expect(err.message.replace(/Try again in \d+ seconds/, "")).not.toMatch(
      /\d/,
    );
    await setRow({ approve_global: 1 });
    await expect(
      approve(params(), null, hashIp(freshIp()), "http://unprompted.test"),
    ).rejects.toMatchObject({ status: 429 });
    expect(await count("connector_grants")).toBe(1);
  });
});

describe("the flood rules read their thresholds from settings", () => {
  it("a spike: fewer sign-ups tighten, for the set number of hours", async () => {
    await setRow({ spike_sign_ups: 2, spike_hours: 3 });
    warnings();
    await register("one");
    const [before] =
      await db()`SELECT 1 FROM settings WHERE key = ${TIGHTENED_UNTIL}`;
    expect(before).toBeUndefined();
    await register("two");
    const [row] = await db()<{ hours: number }[]>`
      SELECT round(extract(epoch FROM ((value #>> '{}')::timestamptz - now())) / 3600)::int AS hours
      FROM settings WHERE key = ${TIGHTENED_UNTIL}`;
    expect(row?.hours).toBe(3);
    const [entry] = await db()<{ reason: string }[]>`
      SELECT detail->>'reason' AS reason FROM action_log
      WHERE action = 'admin.registration.tighten'`;
    expect(entry?.reason).not.toMatch(/\d/);
  });

  it("a spike: counts only within the set minutes", async () => {
    warnings();
    // A sign-up five minutes ago, without spending this hour's quota.
    const earlier = () => db()`
      INSERT INTO action_log (action, subject, at)
      VALUES ('bot.register', 'bot:earlier', now() - interval '5 minutes')`;
    await earlier();
    await setRow({ spike_sign_ups: 2, spike_minutes: 1 });
    await register("one");
    expect(
      await db()`SELECT 1 FROM settings WHERE key = ${TIGHTENED_UNTIL}`,
    ).toHaveLength(0);
    await setRow({ spike_sign_ups: 3, spike_minutes: 10 });
    await register("two");
    expect(
      await db()`SELECT 1 FROM settings WHERE key = ${TIGHTENED_UNTIL}`,
    ).toHaveLength(1);
  });

  async function threeSay(body: string) {
    for (const h of ["alice", "bob", "carol"]) {
      const bot = await register(h);
      expect(
        (await call(post, { key: bot.key, body: { channel: "meta", body } }))
          .status,
      ).toBe(201);
    }
    return db()`SELECT 1 FROM action_log WHERE action = 'alert.duplicate_posts'`;
  }
  const LONG = "The real board moved, everyone come over to our new place!";

  it("duplicates: shorter text raises the alert when the minimum is lower", async () => {
    warnings();
    await setRow({ duplicate_min_letters: 5 });
    expect(await threeSay("come over")).toHaveLength(1);
  });

  it("duplicates: on the defaults, short text raises nothing", async () => {
    warnings();
    expect(await threeSay("come over")).toHaveLength(0);
  });

  it("duplicates: more bots are needed when the threshold is higher", async () => {
    warnings();
    await setRow({ duplicate_bots: 4 });
    expect(await threeSay(LONG)).toHaveLength(0);
  });

  it("duplicates: on the defaults, three bots are enough", async () => {
    warnings();
    expect(await threeSay(LONG)).toHaveLength(1);
  });
});

describe("how long a bot counts as new", () => {
  async function isNew(key: string): Promise<boolean> {
    return (await call(me, { key, path: "/v1/me" })).body.bot.is_new;
  }

  it("follows new_bot_hours", async () => {
    const a = await register("alice");
    await db()`UPDATE bots SET created_at = now() - interval '6 hours' WHERE handle = 'alice'`;
    expect(await isNew(a.key)).toBe(true);
    await setRow({ new_bot_hours: 5 });
    expect(await isNew(a.key)).toBe(false);
    await setRow({ new_bot_hours: 7 });
    expect(await isNew(a.key)).toBe(true);
  });

  it("follows new_bot_hidden_days", async () => {
    const a = await register("alice");
    await db()`UPDATE bots SET created_at = now() - interval '30 days' WHERE handle = 'alice'`;
    const id = (
      await call(post, { key: a.key, body: { channel: "meta", body: "x" } })
    ).body.post.id as number;
    await hidePost(db(), id, "Testing.");
    await db()`UPDATE hidden_posts SET hidden_at = now() - interval '3 days'`;
    expect(await isNew(a.key)).toBe(true);
    await setRow({ new_bot_hidden_days: 2 });
    expect(await isNew(a.key)).toBe(false);
  });

  it("uses the default when the value doesn't fit, at the database too", async () => {
    const a = await register("alice");
    await db()`UPDATE bots SET created_at = now() - interval '6 hours' WHERE handle = 'alice'`;
    for (const bad of ["5", 0, 721, 5.5, -1, null, { h: 5 }]) {
      warnings();
      await setRow({ new_bot_hours: bad });
      expect(await isNew(a.key), JSON.stringify(bad)).toBe(true);
      vi.restoreAllMocks();
    }
    for (const row of ["5", [5], 5])
      await setRow(row).then(async () =>
        expect(await isNew(a.key), JSON.stringify(row)).toBe(true),
      );
  });

  it("a tighter quarantine refuses the new-bot quota sooner, writing nothing", async () => {
    const a = await register("alice");
    await db()`UPDATE bots SET created_at = now() - interval '30 hours' WHERE handle = 'alice'`;
    await setRow({ new_bot_hours: 48 });
    const [bot] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'alice'`;
    await db()`INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`post:new:${bot?.id}`}, to_timestamp(floor(extract(epoch FROM now()) / 86400) * 86400), ${LIMITS.postNewPerDay.limit})`;
    const refused = await call(post, {
      key: a.key,
      body: { channel: "meta", body: "one more" },
    });
    expect(refused.status).toBe(429);
    expect(await count("posts")).toBe(0);
  });
});

describe("the admin command", () => {
  it("validates the values file and writes nothing when it doesn't fit", async () => {
    for (const bad of [
      { register_per_ip: 0 },
      { register_per_ip: 4.5 },
      { register_per_ip: "4" },
      { unknown_cap: 4 },
      [1, 2],
      "text",
      null,
    ]) {
      await expect(setAntiAbuse(db(), bad, "Testing.")).rejects.toMatchObject({
        code: "invalid_limits",
      });
    }
    await expect(setAntiAbuse(db(), SOME, "")).rejects.toMatchObject({
      code: "invalid_reason",
    });
    expect(await count("settings")).toBe(0);
    expect(await count("action_log")).toBe(0);
  });

  it("names the fields that don't fit, never their values", async () => {
    const err = await setAntiAbuse(
      db(),
      { register_per_ip: 31_337, spike_hours: 4242, bogus: 1 },
      "Testing.",
    ).catch((e) => e);
    expect(err.message).toContain("register_per_ip");
    expect(err.message).toContain("spike_hours");
    expect(err.message).toContain("bogus");
    expect(err.message).not.toMatch(/31337|4242/);
  });

  it("loads the values, replacing the row, and logs the change without them", async () => {
    await setAntiAbuse(db(), { report_per_hour: 3 }, "First load.");
    const res = await setAntiAbuse(db(), SOME, "Preview values.");
    expect(res.changed).toBe(true);
    expect(await antiAbuse(db())).toEqual({ ...ANTI_ABUSE_DEFAULTS, ...SOME });
    const log = await db()<
      { action: string; subject: string; detail: unknown }[]
    >`
      SELECT action, subject, detail FROM action_log ORDER BY id`;
    expect(log.map((l) => l.action)).toEqual([
      "admin.limits.set",
      "admin.limits.set",
    ]);
    expect(log[1]).toMatchObject({
      subject: "limits",
      detail: {
        reason: "Preview values.",
        set: "register_per_ip,post_global,new_bot_hours",
      },
    });
    const all = JSON.stringify(log);
    for (const v of Object.values(SOME)) expect(all).not.toContain(String(v));
    expect(all).not.toContain('"report_per_hour":3');
  });

  it("shows each number and where it came from", async () => {
    await setRow({ register_per_ip: 4, post_global: "bad" });
    warnings();
    const rows = await showAntiAbuse(db());
    expect(rows.map((r) => r.name)).toEqual(ANTI_ABUSE_NAMES);
    expect(rows.find((r) => r.name === "register_per_ip")).toEqual({
      name: "register_per_ip",
      value: 4,
      from: "settings",
    });
    expect(rows.find((r) => r.name === "post_global")).toEqual({
      name: "post_global",
      value: ANTI_ABUSE_DEFAULTS.post_global,
      from: "default",
    });
  });

  it("runs from the command line, reading a file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "limits-"));
    try {
      const good = path.join(dir, "limits.json");
      const bad = path.join(dir, "bad.json");
      writeFileSync(good, JSON.stringify(SOME));
      writeFileSync(bad, '{"register_per_ip": 0}');
      const url = process.env.TEST_DATABASE_URL as string;
      const run = (...args: string[]) =>
        spawnSync(
          "npx",
          ["tsx", "--conditions=react-server", "scripts/admin.ts", ...args],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              DATABASE_URL: url,
              DATABASE_URL_UNPOOLED: url,
            },
          },
        );
      const refused = run("limits", "set", bad, "--reason", "Bad file.");
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("register_per_ip");
      const noReason = run("limits", "set", good);
      expect(noReason.status).toBe(1);
      const loaded = run("limits", "set", good, "--reason", "Loaded.");
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout).toContain("Loaded 3 anti-abuse number(s)");
      expect(loaded.stdout).not.toMatch(/\b(4|41|5)\b/);
      const shown = run("limits", "show");
      expect(shown.status).toBe(0);
      expect(shown.stdout).toMatch(/register_per_ip\s+4\s+\(settings\)/);
      expect(shown.stdout).toMatch(/spike_hours\s+1\s+\(default\)/);
      expect(readFileSync(good, "utf8")).toBe(JSON.stringify(SOME));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
