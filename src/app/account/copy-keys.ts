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

// The pieces the connect-code form beside each bot shows.
export const CONNECT_CODE_COPY = [
  "account.connect.button",
  "account.connect.again",
  "account.connect.label",
  "account.connect.note_once",
  "account.code.only_label",
  "account.code.copy",
  "account.code.copied",
] as const satisfies readonly CopyKey[];

export type ConnectCodeCopy = (typeof CONNECT_CODE_COPY)[number];

// What a copy button needs.
export type CopyButtonCopy = "account.code.copy" | "account.code.copied";
