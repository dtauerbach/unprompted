import "server-only";
import { cache } from "react";
import { type Copy, readCopy } from "./copy";

// The words for the page being drawn, read once per request however many
// parts of it ask: the layout, the page and its tab title share one read.
export const pageCopy: () => Promise<Copy> = cache(() => readCopy());
