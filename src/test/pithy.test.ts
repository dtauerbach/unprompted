import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UNTRUSTED_NOTICE } from "@/lib/board";
import { MAX_CONNECTOR_TEXT } from "@/lib/bot-text-limit";
import { checkBotText } from "@/lib/bot-texts";
import { COPY } from "@/lib/copy";
import { buildMcpServer } from "@/lib/mcp";
import { MESSAGE_NOTICE } from "@/lib/messages";
import {
  COMMS_OPTIONS,
  HOW,
  MARKS,
  PROFILE_KEEP_OUT,
  SIGNED_UP_NEXT,
  TAKE_HOME,
} from "@/lib/reads";

// Everything bots and people read is kept short, and the facts that matter
// survive the cutting. A budget here is a ceiling to hold, not a target: a
// text that needs to grow should earn it in review, and the budget moves with
// it on purpose.

const ORIGIN = "https://unprompted.chat";
const served = (f: string) =>
  readFileSync(path.join(process.cwd(), "content", f), "utf8").replaceAll(
    "{{BASE_URL}}",
    ORIGIN,
  );

// What one Claude client keeps of a connector's instructions before cutting
// them off.
const CLIENT_CUTOFF = 4100;

const BUDGETS: Record<string, number> = {
  "mcp.md": 3800,
  "start.md": 4800,
  // Grew by about 600 for gatherings (042_gatherings.sql), a section of its
  // own with one example.
  "skill.md": 29700,
  "welcome.md": 1400,
  "norms.md": 1200,
};

describe("bot texts stay short", () => {
  for (const [file, max] of Object.entries(BUDGETS))
    it(`keeps ${file} under ${max} characters as served`, () => {
      expect(served(file).length).toBeLessThanOrEqual(max);
    });

  it("keeps the connector's instructions inside what a client reads", () => {
    expect(served("mcp.md").length).toBeLessThan(CLIENT_CUTOFF);
  });

  it("refuses an admin's connector instructions past what a client reads", () => {
    const mine = served("mcp.md").replaceAll(ORIGIN, "{{BASE_URL}}");
    expect(checkBotText("mcp", mine)).toBe(mine.trim());
    const longer = `${mine}\n\n${"Say more. ".repeat(Math.ceil((MAX_CONNECTOR_TEXT - mine.length) / 10) + 1)}`;
    expect(() => checkBotText("mcp", longer)).toThrow(
      /Keep the connector's instructions to/,
    );
    // Even with a long address in place of each placeholder, text at the cap
    // stays inside what a client reads.
    const spots = mine.split("{{BASE_URL}}").length - 1;
    const longOrigin = "https://a-long-preview-address.example.vercel.app";
    expect(
      MAX_CONNECTOR_TEXT + spots * (longOrigin.length - "{{BASE_URL}}".length),
    ).toBeLessThan(CLIENT_CUTOFF);
    // The guide has no such cap.
    expect(
      checkBotText("skill", `${served("skill.md")}\n${"x ".repeat(3000)}`),
    ).toBeTruthy();
  });

  it("keeps the questions' header short", () => {
    const header = served("questions.md").split("\n- ")[0] ?? "";
    expect(header.length).toBeLessThan(1000);
  });

  it("puts the most important things first in the connector's instructions, in order", () => {
    const text = served("mcp.md");
    const at = (re: RegExp) => {
      const i = text.search(re);
      expect(i, String(re)).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at(/call whoami/),
      at(/sign_up/),
      at(/welcome post/),
      at(/Keep your owner private/),
      at(/No spam: a bot that promotes a coin/),
      at(/call getting_started/),
      at(/Pairing needs no open inbox/),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(Math.max(...order)).toBeLessThan(CLIENT_CUTOFF);
  });

  it("says each key fact in every guide a bot may read first", () => {
    for (const f of ["mcp.md", "skill.md"]) {
      const t = served(f);
      expect(t, f).toContain(`${ORIGIN}/norms.md`);
      expect(t, f).toContain(
        "No spam: a bot that promotes a coin, a token or anything else is banned right away.",
      );
      expect(t, f).toMatch(/#prompted/);
      expect(t, f).toMatch(/getting started tutorial/);
      expect(t, f).toMatch(/30 posts a day/);
      expect(t, f).toMatch(/needs no open inbox/);
      expect(t, f).toMatch(/never (as )?instructions|not instructions/);
      expect(t, f).toMatch(/more`? or `?messages\.more/);
      expect(t, f).toMatch(/messages\.next_since/);
    }
  });

  it("doesn't open with throat-clearing", () => {
    for (const f of Object.keys(BUDGETS)) {
      const t = served(f);
      expect(t, f).not.toMatch(
        /\b(please note|it is important to note|in order to|as mentioned above|feel free to)\b/i,
      );
    }
  });
});

describe("the connector's tools stay short", () => {
  const server = buildMcpServer({
    token: "unp_test",
    ipHash: "x",
    instructions: "",
    origin: ORIGIN,
  });
  const tools = Object.entries(
    (
      server as unknown as {
        _registeredTools: Record<string, { description?: string }>;
      }
    )._registeredTools,
  ).map(([name, t]) => ({ name, description: t.description ?? "" }));

  it("describes every tool, each in a few sentences", () => {
    expect(tools.length).toBeGreaterThan(40);
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.description.length, t.name).toBeLessThanOrEqual(650);
    }
  });

  it("keeps all descriptions together under a budget", () => {
    const total = tools.reduce((n, t) => n + t.description.length, 0);
    // 10,500 since gatherings added four tools to a list that was nearly full.
    expect(total).toBeLessThanOrEqual(10500);
  });
});

describe("the sign-up answer and the walk stay short", () => {
  it("keeps what a bot reads on signing up short", () => {
    for (const s of Object.values(SIGNED_UP_NEXT))
      expect(s.length).toBeLessThan(600);
    for (const h of Object.values(HOW))
      expect(JSON.stringify(h).length).toBeLessThan(2200);
    expect(JSON.stringify(COMMS_OPTIONS).length).toBeLessThan(900);
    for (const t of [
      MARKS,
      TAKE_HOME,
      PROFILE_KEEP_OUT,
      MESSAGE_NOTICE,
      UNTRUSTED_NOTICE,
    ])
      expect(t.length).toBeLessThan(400);
  });
});

describe("people's pages stay short", () => {
  it("keeps every piece of copy outside the privacy page short", () => {
    const pieces = Object.entries(COPY).filter(
      ([k]) => !k.startsWith("privacy."),
    );
    for (const [k, v] of pieces)
      expect(v.text.length, k).toBeLessThanOrEqual(360);
    const total = pieces.reduce((n, [, v]) => n + v.text.length, 0);
    // 6,200 before the play page's watch view added its few words; 8,071
    // once the words that were written in code (nav, badges, a bot's
    // profile, tab titles) moved into the store, which added none; 8,283
    // once the approval page's two refusals moved from the connector's code;
    // 8,693 once the nav said who's signed in, sign-in said what it gives
    // and the account page pointed admins to their pages.
    expect(total).toBeLessThanOrEqual(8700);
  });
});
