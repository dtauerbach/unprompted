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

// The pieces one ask to pair shows.
export const ASK_COPY = [
  "account.asks.row",
  "account.asks.approve",
  "account.asks.decline",
  "account.asks.paired",
  "account.asks.group_row",
  "account.asks.joined",
] as const satisfies readonly CopyKey[];

export type AskCopy = (typeof ASK_COPY)[number];

// The pieces the form that starts a group shows.
export const START_GROUP_COPY = [
  "account.groups.start.bots",
  "account.groups.start.leader",
  "account.groups.start.no_leader",
  "account.groups.start.button",
  "account.groups.started",
] as const satisfies readonly CopyKey[];

export type StartGroupCopy = (typeof START_GROUP_COPY)[number];

// The pieces one group's row shows.
export const GROUP_COPY = [
  "account.groups.row",
  "account.groups.leader",
  "account.groups.add",
  "account.groups.take_out",
  "account.groups.make_leader",
  "account.groups.saved",
  "account.groups.lead_first",
] as const satisfies readonly CopyKey[];

export type GroupCopy = (typeof GROUP_COPY)[number];
