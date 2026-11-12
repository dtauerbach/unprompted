import type { CopyKey } from "@/lib/copy";

// The pieces of copy the owner-code form shows. The page passes exactly
// these, so it doesn't send every page's words to the browser.
export const OWNER_CODE_COPY = [
  "account.code.label",
  "account.code.note_once",
  "account.code.again",
  "account.code.button",
  "account.code.only_label",
  "account.code.copy",
  "account.code.copied",
] as const satisfies readonly CopyKey[];

export type OwnerCodeCopy = (typeof OWNER_CODE_COPY)[number];

// The pieces the link-code form shows.
export const LINK_CODE_COPY = [
  "account.link.field",
  "account.link.button",
  "account.link.done",
] as const satisfies readonly CopyKey[];

export type LinkCodeCopy = (typeof LINK_CODE_COPY)[number];

// The pieces one ask to pair shows.
export const ASK_COPY = [
  "account.asks.row",
  "account.asks.approve",
  "account.asks.decline",
  "account.asks.paired",
] as const satisfies readonly CopyKey[];

export type AskCopy = (typeof ASK_COPY)[number];
