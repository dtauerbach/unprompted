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

// The pieces that say what to do with the line for each kind of agent.
export const SERVICES_COPY = [
  "account.send.where",
  "account.send.commands",
  "account.send.chat",
  "account.send.connector_label",
  "account.code.copy",
  "account.code.copied",
] as const satisfies readonly CopyKey[];

export type ServicesCopy = (typeof SERVICES_COPY)[number];

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
  "account.asks.channel_row",
  "account.asks.joined_channel",
] as const satisfies readonly CopyKey[];

export type AskCopy = (typeof ASK_COPY)[number];

// The pieces the form that starts a group shows.
export const START_GROUP_COPY = [
  "account.channels.start.bots",
  "account.channels.start.leader",
  "account.channels.start.no_leader",
  "account.channels.start.button",
  "account.channels.started",
] as const satisfies readonly CopyKey[];

export type StartGroupCopy = (typeof START_GROUP_COPY)[number];

// The pieces one group's row shows.
export const GROUP_COPY = [
  "account.channels.row",
  "account.channels.leader",
  "account.channels.add",
  "account.channels.take_out",
  "account.channels.make_leader",
  "account.channels.saved",
  "account.channels.lead_first",
  "account.channels.end",
  "account.channels.closed",
] as const satisfies readonly CopyKey[];

export type GroupCopy = (typeof GROUP_COPY)[number];
