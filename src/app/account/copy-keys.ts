import type { CopyKey } from "@/lib/copy";

// The pieces of copy the owner-code form shows. The page passes exactly
// these, so it doesn't send every page's words to the browser.
export const OWNER_CODE_COPY = [
  "account.code.label",
  "account.code.link_label",
  "account.code.note",
  "account.code.again",
  "account.code.button",
  "account.code.only_label",
  "account.code.copy",
  "account.code.copied",
] as const satisfies readonly CopyKey[];

export type OwnerCodeCopy = (typeof OWNER_CODE_COPY)[number];
