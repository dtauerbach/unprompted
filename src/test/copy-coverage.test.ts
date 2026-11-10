import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isCopyKey } from "@/lib/copy";

// The words people read live in one place: the copy store (src/lib/copy.ts
// seeds it, /admin/copy edits it). This test reads the code of every page
// and component people see and fails on any words written there instead,
// so a line can't quietly bypass the store.
//
// What it counts as words: text between tags, a string or template given to
// a tag or rendered inside {...}, a page's tab title and description, and,
// anywhere else in these files, a string that reads like prose (it starts
// with a capital and a lowercase letter, or holds two words, or ends a
// sentence). Class names, links, ids and copy keys aren't words.

const ROOT = join(__dirname, "..", "..");

// Pages for people, and the components they're drawn from. The admin pages
// are tools for admins; the API, the connector and the texts bots read
// (route.ts files, /v1, /mod) aren't pages for people.
const SCANNED = ["src/app", "src/components"];
const SKIPPED = [
  /^src\/app\/admin\//,
  /^src\/app\/v1\//,
  /^src\/app\/mod\//,
  /\/route\.ts$/,
  // Server actions: their refusals are the shared server errors (ApiError)
  // the API gives bots too, so they stay in code.
  /\/actions\.ts$/,
];

// Lib modules that build words for pages.
const LIB_PAGE_WORDS = ["src/lib/time.ts"];

// Props that hold no words: structure, styling, addresses and wiring.
const STRUCTURAL_ATTRS = new Set([
  "className",
  "href",
  "src",
  "id",
  "key",
  "type",
  "name",
  "method",
  "rel",
  "target",
  "role",
  "htmlFor",
  "lang",
  "dateTime",
  "autoComplete",
  "viewBox",
  "fill",
  "stroke",
  "strokeWidth",
  "strokeLinecap",
  "strokeLinejoin",
  "d",
  "width",
  "height",
  "cx",
  "cy",
  "r",
  "aria-hidden",
  "aria-current",
  "aria-live",
  "inputMode",
  "pattern",
  "spellCheck",
  "path",
  "sort",
  "copyKey",
  "size",
  "loading",
  "decoding",
  "encType",
  "prefetch",
  "scroll",
  "action",
  "textAnchor",
  "dominantBaseline",
  "icon",
]);

// Directives, not words.
const NOT_WORDS = new Set(["use client", "use server", "server-only"]);

// Notation rather than words: a community's c/ and a handle's @ before a
// name, a tab title's pattern, a path or an address shown as itself.
const NOTATION =
  /^(c\/(\{\})?|@\{\}|%s · \{\}|\/[\w./-]*|[a-z0-9-]+(\.[a-z0-9-]+)+(\/[\w./-]*)?)$/;

function notWords(text: string): boolean {
  const t = text.trim();
  return NOT_WORDS.has(t) || NOTATION.test(t) || isCopyKey(t);
}

// A single lowercase token handed to a function, like a section's name or a
// locale, is wiring rather than words.
function isIdentifierArgument(node: ts.Node, text: string): boolean {
  const p = node.parent;
  return (
    p !== undefined &&
    ts.isCallExpression(p) &&
    p.arguments.includes(node as ts.Expression) &&
    /^[a-z][a-zA-Z]*(-[A-Z]{2})?$/.test(text)
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function scannedFiles(): string[] {
  return [
    ...SCANNED.flatMap(walk).filter((f) => !SKIPPED.some((r) => r.test(f))),
    ...LIB_PAGE_WORDS,
  ].sort();
}

const LETTER = /[A-Za-z]/;

// A string that reads like prose rather than a class list, a path or a key.
export function readsLikeProse(s: string): boolean {
  const t = s.trim();
  if (t === "" || notWords(t)) return false;
  // Paths, addresses, class lists and patterns.
  if (/^(\/|\.|@\/|https?:|#|\$|\^)/.test(t)) return false;
  const words = t.split(/\s+/);
  const plain = words.filter((w) => /^[A-Za-z']+[,.!?:;]?$/.test(w));
  const classy = words.some(
    (w) => /[-:[\]/]/.test(w) && !/^[A-Za-z']+-[A-Za-z']+[,.!?]?$/.test(w),
  );
  if (classy && plain.length < 3) return false;
  if (/^[A-Z][a-z]/.test(t)) return true;
  if (plain.length >= 2) return true;
  // A count beside a word: "1 thread", "{} replies".
  if (
    plain.some((w) => /[a-z]{2}/.test(w)) &&
    words.some((w) => /^(\d+|\{\})$/.test(w))
  )
    return true;
  return /[a-z][.!?]$/.test(t);
}

type Finding = { file: string; line: number; text: string; why: string };

function textOf(node: ts.Node, sf: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)]
      .join("{}")
      .trim();
  if (ts.isJsxText(node)) return node.getText(sf);
  return undefined;
}

// Whether a string sits where its value is shown or passed on, rather than
// compared, used as a key or handed to a function that takes no words.
function isValuePosition(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node)
    return false;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.InKeyword
    )
      return false;
  }
  if (ts.isCaseClause(p)) return false;
  if (ts.isPropertyAssignment(p) && p.name === node) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return false;
  if (ts.isLiteralTypeNode(p)) return false;
  if (ts.isExpressionStatement(p)) return false;
  return true;
}

function attrName(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isJsxAttribute(n)) return n.name.getText();
    if (ts.isPropertyAssignment(n))
      return n.name.getText().replace(/['"]/g, "");
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) return undefined;
  }
  return undefined;
}

function insideJsx(node: ts.Node): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isJsxExpression(n) || ts.isJsxAttribute(n)) return true;
    if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

function insideConsoleOrError(node: ts.Node): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = n.expression.getText();
      if (/^console\.|^(new )?(Error|ApiError|TypeError)$/.test(callee))
        return true;
      if (/^(Error|ApiError|TypeError)$/.test(callee)) return true;
    }
    if (ts.isFunctionLike(n)) return false;
  }
  return false;
}

function inMetadata(node: ts.Node): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isVariableDeclaration(n) && n.name.getText() === "metadata")
      return true;
    if (ts.isFunctionDeclaration(n) && n.name?.getText() === "generateMetadata")
      return true;
  }
  return false;
}

export function findWords(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: Finding[] = [];
  const add = (node: ts.Node, text: string, why: string) =>
    found.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      text: text.trim().slice(0, 80),
      why,
    });
  const visit = (node: ts.Node) => {
    const text = textOf(node, sf);
    if (text !== undefined && LETTER.test(text) && !notWords(text)) {
      if (ts.isJsxText(node)) add(node, text, "text between tags");
      else if (
        isValuePosition(node) &&
        !insideConsoleOrError(node) &&
        !isIdentifierArgument(node, text)
      ) {
        const attr = attrName(node);
        const structural = attr !== undefined && STRUCTURAL_ATTRS.has(attr);
        if (inMetadata(node) && !structural && !isCopyKey(text))
          add(node, text, "a page's tab title or description");
        else if (
          insideJsx(node) &&
          !structural &&
          !isCopyKey(text) &&
          !NOT_WORDS.has(text) &&
          !/^(\/|#|https?:)/.test(text)
        )
          add(node, text, "a string shown on the page");
        else if (!structural && readsLikeProse(text))
          add(node, text, "a string that reads like words");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("words on the pages people read", () => {
  it("all come from the copy store", () => {
    const found = scannedFiles().flatMap((f) =>
      findWords(f, readFileSync(join(ROOT, f), "utf8")),
    );
    const report = found.map(
      (f) =>
        `${relative(".", f.file)}:${f.line} ${f.why}: ${JSON.stringify(f.text)}`,
    );
    expect(
      report,
      "Put these words in the copy store (COPY in src/lib/copy.ts) and read them with readCopy()",
    ).toEqual([]);
  });
});

describe("the words scanner", () => {
  const found = (src: string, file = "src/app/x/page.tsx") =>
    findWords(file, src).map((f) => f.text);

  it("catches words written in a page instead of the store", () => {
    expect(found("export default () => <p>Hello there</p>;")).toEqual([
      "Hello there",
    ]);
    expect(
      found('export default () => <img alt="A photo of bots" />;'),
    ).toEqual(["A photo of bots"]);
    expect(found('export default () => <p>{"Not in the store"}</p>;')).toEqual([
      "Not in the store",
    ]);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test
      found("const n = 2; export default () => <p>{`${n} replies`}</p>;"),
    ).toEqual(["{} replies"]);
    expect(
      found('export const metadata = { title: "Forum", description: "x" };'),
    ).toEqual(["Forum", "x"]);
    expect(found('const label = "Back to the forum";')).toEqual([
      "Back to the forum",
    ]);
    expect(found('const s = "Yesterday";')).toEqual(["Yesterday"]);
    // A button's value and a field's starting text are words people read.
    expect(
      found(
        'export default () => <input type="submit" value="Send it now" />;',
      ),
    ).toEqual(["Send it now"]);
    expect(
      found('export default () => <input defaultValue="Your name here" />;'),
    ).toEqual(["Your name here"]);
  });

  it("leaves design, wiring and copy keys alone", () => {
    expect(
      found(
        'export default ({ t }) => <a href="/forum" className="text-sm underline">{t["forum.title"]}</a>;',
      ),
    ).toEqual([]);
    expect(found('"use client";\nimport x from "react";')).toEqual([]);
    expect(
      found('if (status === "live") throw new Error("Not found here");'),
    ).toEqual([]);
    expect(found('console.warn("Something went wrong");')).toEqual([]);
    expect(found('const c = cls("text-sm font-medium");')).toEqual([]);
    expect(found("export default () => <p>c/{slug}</p>;")).toEqual([]);
    expect(found('fill(t["site.time.minutes"], { n });')).toEqual([]);
    expect(found('export default () => <svg viewBox="0 0 10 10" />;')).toEqual(
      [],
    );
  });

  it("calls things prose the way a reader would", () => {
    expect(readsLikeProse("Hello there")).toBe(true);
    expect(readsLikeProse("1 thread")).toBe(true);
    expect(readsLikeProse("done.")).toBe(true);
    expect(readsLikeProse("text-sm font-medium")).toBe(false);
    expect(readsLikeProse("/forum")).toBe(false);
    expect(readsLikeProse("forum.title")).toBe(false);
    expect(readsLikeProse("live")).toBe(false);
  });

  it("scans the pages and components, and skips the admin pages and the API", () => {
    const files = scannedFiles();
    expect(files).toContain("src/app/page.tsx");
    expect(files).toContain("src/app/layout.tsx");
    expect(files).toContain("src/components/post-list.tsx");
    expect(files.some((f) => f.startsWith("src/app/admin/"))).toBe(false);
    expect(files.some((f) => f.startsWith("src/app/v1/"))).toBe(false);
  });
});
