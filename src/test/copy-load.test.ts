import { beforeEach, describe, expect, it } from "vitest";
import { moderatorLog } from "@/lib/admin";
import { addAdmin, adminHumanId } from "@/lib/admins";
import {
  COPY,
  type CopyKey,
  checkCopy,
  copyHistory,
  latestVersions,
  loadCopy,
  readCopy,
  saveCopy,
} from "@/lib/copy";
import { db } from "@/lib/db";
import { ensureHuman } from "@/lib/humans";
import { resetDb } from "./helpers";

// Words kept outside this repo, like the privacy page's in the private legal
// repo, reach the site as a file loaded from the command line. These check a
// load saves every piece or none, with the checks a save at /admin/copy has,
// under an admin's name, logged once; and that the privacy page's rules hold
// for every version of it, however it was saved.

beforeEach(resetDb);

async function anAdmin(id = "google-admin"): Promise<number> {
  return (await addAdmin(db(), { authUserId: id }, "Testing.", "test")).humanId;
}

function load(humanId: number, pieces: unknown, reason = "Legal repo sync.") {
  return loadCopy(db(), { pieces, humanId, reason, by: "test" });
}

async function versionCount(): Promise<number> {
  const [row] = await db()<
    { n: string }[]
  >`SELECT count(*) AS n FROM copy_versions`;
  return Number(row?.n);
}

async function loadLog() {
  return db()<{ human_id: string | null; detail: Record<string, unknown> }[]>`
    SELECT human_id, detail FROM action_log WHERE action = 'admin.copy.load' ORDER BY id`;
}

const privacyKeys = (Object.keys(COPY) as CopyKey[]).filter(
  (k) => COPY[k].page === "privacy",
);

describe("loading copy from a file", () => {
  it("saves every changed piece as a new version under the admin, logged once with its reason", async () => {
    const admin = await anAdmin();
    const r = await load(admin, {
      "privacy.lead": "New words for the lead.",
      "privacy.changes.text": "When this page changes, the date above changes.",
      "home.tagline": COPY["home.tagline"].text,
    });
    expect(r.changed).toEqual(["privacy.changes.text", "privacy.lead"]);
    // The built-in words, written out, aren't a change.
    expect(r.unchanged).toEqual(["home.tagline"]);
    const words = await readCopy(db());
    expect(words["privacy.lead"]).toBe("New words for the lead.");
    expect(words["home.tagline"]).toBe(COPY["home.tagline"].text);
    const [h] = await copyHistory(db(), "privacy.lead");
    expect(h?.human_id).toBe(admin);
    const log = await loadLog();
    expect(log).toHaveLength(1);
    expect(Number(log[0]?.human_id)).toBe(admin);
    expect(log[0]?.detail).toMatchObject({
      reason: "Legal repo sync.",
      by: "test",
      keys: ["privacy.changes.text", "privacy.lead"],
    });
    expect((log[0]?.detail.versions as number[]).length).toBe(2);
    // In the moderators' record, with its reason.
    const [entry] = await moderatorLog(db(), { limit: 5 });
    expect(entry).toMatchObject({
      action: "copy.load",
      subject: "copy",
      reason: "Legal repo sync.",
    });
  });

  it("changes nothing and logs nothing when the file matches what's in force", async () => {
    const admin = await anAdmin();
    const file = { "privacy.lead": "New words for the lead." };
    await load(admin, file);
    const before = await versionCount();
    const again = await load(admin, file);
    expect(again.changed).toEqual([]);
    expect(again.unchanged).toEqual(["privacy.lead"]);
    expect(await versionCount()).toBe(before);
    expect(await loadLog()).toHaveLength(1);
  });

  it("leaves a piece that's never been edited alone when the file says null", async () => {
    const admin = await anAdmin();
    const r = await load(admin, { "privacy.lead": null });
    expect(r.changed).toEqual([]);
    expect(await versionCount()).toBe(0);
  });

  it("goes back to the built-in text for a piece set to null", async () => {
    const admin = await anAdmin();
    await load(admin, { "privacy.lead": "New words for the lead." });
    const r = await load(admin, { "privacy.lead": null });
    expect(r.changed).toEqual(["privacy.lead"]);
    expect((await readCopy(db()))["privacy.lead"]).toBe(
      COPY["privacy.lead"].text,
    );
  });

  it("normalises the words the same way a save at /admin/copy does", async () => {
    const admin = await anAdmin();
    await load(admin, { "privacy.lead": "  Spaced\n\nout   words.  " });
    expect((await readCopy(db()))["privacy.lead"]).toBe("Spaced out words.");
  });

  it("saves nothing at all if any piece fails its checks, and names each one", async () => {
    const admin = await anAdmin();
    const err = await load(admin, {
      "privacy.lead": "Fine words.",
      "privacy.contact.text": "No link here.",
      "home.tagline": "Bots play.‮",
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/^Nothing was saved\./);
    expect(message).toContain("privacy.contact.text: Keep {contact}");
    expect(message).toMatch(/home\.tagline: .*invisible/);
    expect(message).not.toContain("privacy.lead:");
    expect(await versionCount()).toBe(0);
    expect(await loadLog()).toHaveLength(0);
  });

  it("refuses a file that isn't one object of known pieces to words or null", async () => {
    const admin = await anAdmin();
    for (const bad of [
      null,
      [],
      "words",
      {},
      { "privacy.nothing": "x" },
      { ["x".repeat(500)]: "x" },
      { "privacy.lead": 3 },
      { "privacy.lead": ["x"] },
      JSON.parse('{"__proto__": "x"}'),
      JSON.parse('{"constructor": "x"}'),
    ])
      await expect(load(admin, bad), JSON.stringify(bad)).rejects.toThrow();
    expect(await versionCount()).toBe(0);
  });

  it("names an unknown piece without echoing more than a short bit of it", async () => {
    const admin = await anAdmin();
    const err = await load(admin, {
      [`privacy.${"x".repeat(200)}`]: "x",
    }).catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(120);
  });

  it("needs a one-line reason, kept with the load", async () => {
    const admin = await anAdmin();
    for (const reason of ["", "two\nlines", "x".repeat(281)])
      await expect(
        load(admin, { "privacy.lead": "Words." }, reason),
      ).rejects.toThrow(/reason/);
    expect(await versionCount()).toBe(0);
  });

  it("refuses an edit made at /admin/copy against a version the load replaced", async () => {
    const admin = await anAdmin();
    const seen = (await latestVersions(db())).get("privacy.lead")?.id ?? 0;
    await load(admin, { "privacy.lead": "Loaded words." });
    await expect(
      saveCopy(db(), {
        key: "privacy.lead",
        body: "Typed words.",
        after: seen,
        editor: { humanId: admin, role: "admin", keyId: null },
        ipHash: null,
      }),
    ).rejects.toThrow(/newer version/);
    expect((await readCopy(db()))["privacy.lead"]).toBe("Loaded words.");
  });
});

describe("who a load is saved under", () => {
  it("is an admin, found by sign-in id", async () => {
    const admin = await anAdmin("legal-admin");
    expect(await adminHumanId(db(), { authUserId: "legal-admin" })).toBe(admin);
  });

  it("refuses someone who has signed in but isn't an admin", async () => {
    await db().begin((tx) => ensureHuman(tx, "just-a-reader"));
    await expect(
      adminHumanId(db(), { authUserId: "just-a-reader" }),
    ).rejects.toThrow(/aren't an admin/);
  });

  it("refuses someone who has never signed in", async () => {
    await expect(
      adminHumanId(db(), { authUserId: "nobody-at-all" }),
    ).rejects.toThrow(/aren't an admin/);
  });
});

describe("the privacy page's rules, for every version of it", () => {
  it("holds the built-in words to them", () => {
    for (const key of privacyKeys)
      expect(checkCopy(key, COPY[key].text), key).toBe(COPY[key].text);
  });

  it("refuses a promise about who can see which bots are whose", () => {
    for (const words of [
      "Which bots are yours is shown to you and to nobody else.",
      "Nobody else can see which bots you own.",
      "The site never says which human runs a bot.",
    ])
      expect(() => checkCopy("privacy.people.text", words), words).toThrow(
        /which bots belong to whom/,
      );
  });

  it("refuses the promises it was written to avoid", () => {
    for (const words of [
      "The site doesn't keep the address a request came from.",
      "We never store anything about you.",
      "There are no ads or analytics here.",
      "Records are deleted after a while.",
      "Logs go after thirty days.",
      "The site is GDPR compliant.",
      "Your data is safe with us. It is safe.",
    ])
      expect(() => checkCopy("privacy.kept.text", words), words).toThrow(
        /doesn't promise/,
      );
  });

  it("refuses any number but its date and the two ages", () => {
    for (const words of [
      "A bot may post 5 times an hour.",
      "Addresses are cut to a /64.",
      "Up to ten bots each, or 1 in a million.",
    ])
      expect(() => checkCopy("privacy.kept.text", words), words).toThrow(
        /names no numbers/,
      );
    expect(
      checkCopy("privacy.people.text", "You must be 18 or older, and not 13."),
    ).toBe("You must be 18 or older, and not 13.");
  });

  it("holds the date to its form", () => {
    expect(checkCopy("privacy.effective", "Effective January 9, 2027")).toBe(
      "Effective January 9, 2027",
    );
    for (const words of [
      "Effective 2027-01-09",
      "Effective soon",
      "Effective January 9, 2027, until 2028",
    ])
      expect(() => checkCopy("privacy.effective", words), words).toThrow(
        /Write the date/,
      );
  });

  it("doesn't catch ordinary words that only contain a promise's letters", () => {
    for (const words of [
      "Our analysis safety work is private.",
      "We may email your bot's owner code to no one.",
    ])
      expect(checkCopy("privacy.kept.text", words), words).toBe(words);
  });

  it("leaves other pages' words alone", () => {
    expect(checkCopy("home.tagline", "Bots play 24 hours a day.")).toBe(
      "Bots play 24 hours a day.",
    );
  });

  it("refuses them in a load and at /admin/copy alike", async () => {
    const admin = await anAdmin();
    await expect(
      load(admin, { "privacy.kept.text": "We keep addresses for 30 days." }),
    ).rejects.toThrow(/privacy\.kept\.text: The privacy page/);
    await expect(
      saveCopy(db(), {
        key: "privacy.kept.text",
        body: "We keep addresses for 30 days.",
        after: 0,
        editor: { humanId: admin, role: "admin", keyId: null },
        ipHash: null,
      }),
    ).rejects.toThrow(/The privacy page/);
    expect(await versionCount()).toBe(0);
  });

  it("shows the built-in words in place of an older saved version that breaks them", async () => {
    const admin = await anAdmin();
    // As if saved before the rules held saved versions to them.
    await db()`
      INSERT INTO copy_versions (key, body, human_id)
      VALUES ('privacy.stays.text', 'Logs go after 30 days.', ${admin})`;
    expect((await readCopy(db()))["privacy.stays.text"]).toBe(
      COPY["privacy.stays.text"].text,
    );
  });
});
