import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OWNER_CODE_COPY, type OwnerCodeCopy } from "@/app/account/copy-keys";
import { Copyable, OwnerCodeForm } from "@/app/account/forms";
import { CopyButton } from "@/components/copy-button";
import { Words } from "@/components/words";
import { COPY } from "@/lib/copy";
import { OWNER_CODE_RE } from "@/lib/keys";
import { fillLine, PASTE_LINES } from "@/lib/paste-lines";

// The owner code on the account page: one button that says what it gets, the
// lines to paste, and the code on its own, each with a button that copies
// exactly what's shown.

const t = Object.fromEntries(
  OWNER_CODE_COPY.map((k) => [k, COPY[k].text]),
) as Record<OwnerCodeCopy, string>;

const CODE = "own_ABCDEFGHJKMNPQRSTVWX-_";
const ORIGIN = "https://unprompted.test";

describe("the owner code's words", () => {
  it("names what the button gets", () => {
    expect(COPY["account.code.button"].text).toBe("Get an owner code");
    expect(COPY["account.code.again"].text).toBe("Get a new owner code");
    for (const key of [
      "account.code.button",
      "account.code.again",
      "account.code.note",
      "account.send.lead",
    ] as const)
      expect(COPY[key].text, key).not.toMatch(/\bline\b/);
  });

  it("are all passed to the form, and are all the site's own", () => {
    for (const k of OWNER_CODE_COPY) expect(COPY[k].page, k).toBe("account");
    expect(new Set(OWNER_CODE_COPY).size).toBe(OWNER_CODE_COPY.length);
    expect(CODE).toMatch(OWNER_CODE_RE);
  });

  it("has a label for the code on its own and for the copy button", () => {
    expect(COPY["account.code.only_label"].page).toBe("account");
    expect(COPY["account.code.copy"].text).toBe("Copy");
    expect(COPY["account.code.copied"].text).toBe("Copied");
  });
});

describe("filling in a line to paste", () => {
  it("puts the address and the code in their spots, the same as the page shows", () => {
    for (const line of Object.values(PASTE_LINES)) {
      const filled = fillLine(line, ORIGIN, CODE);
      expect(filled).toContain(`${ORIGIN}/agent`);
      expect(filled).toContain(CODE);
      expect(filled).not.toMatch(/[{}]/);
      const shown = renderToStaticMarkup(
        createElement(Words, {
          text: line,
          slots: { address: ORIGIN, code: CODE },
        }),
      );
      expect(shown).toBe(filled);
    }
  });

  it("reads nothing in the address or code as a replacement pattern", () => {
    expect(fillLine("{address} {code}", "a$&b", "$1$'")).toBe("a$&b $1$'");
  });

  it("fills each spot once, so a spot's name inside the address stays as it is", () => {
    expect(fillLine("{address} {code}", "x{code}", "C")).toBe("x{code} C");
  });
});

describe("the owner code's boxes", () => {
  it("shows a label, the exact text, and a copy button", () => {
    const html = renderToStaticMarkup(
      createElement(Copyable, {
        label: t["account.code.only_label"],
        what: t["account.code.only_label"],
        text: CODE,
        t,
      }),
    );
    expect(html).toContain("Or just the code:");
    expect(html).toContain(`>${CODE}</code>`);
    expect(html).toContain('type="button"');
    expect(html).toMatch(
      /aria-label="Copy: Or just the code:"[^>]*>Copy<\/button>/,
    );
    expect(html).toContain('aria-live="polite"');
  });

  it("keeps the text plain, so nothing in it becomes markup", () => {
    const html = renderToStaticMarkup(
      createElement(Copyable, {
        label: "x",
        what: "x",
        text: "<b>hi</b>",
        t,
      }),
    );
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("starts with just the button, which says what it gets", () => {
    const html = renderToStaticMarkup(
      createElement(OwnerCodeForm, { origin: ORIGIN, days: 7, t }),
    );
    expect(html).toContain(">Get an owner code</button>");
    expect(html).not.toContain("<code");
  });

  it("is a plain button, outside any form, so copying never submits", () => {
    const html = renderToStaticMarkup(
      createElement(CopyButton, {
        text: CODE,
        label: "Copy",
        done: "Copied",
        what: "the code",
      }),
    );
    expect(html).toMatch(/^<button type="button"/);
    expect(html).not.toContain(CODE);
  });
});
