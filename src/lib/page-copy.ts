import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { type Copy, readCopy } from "./copy";

// The words for the page being drawn, read once per request however many
// parts of it ask: the layout, the page and its tab title share one read.
// connection() keeps every page that shows words out of the build's
// prerender, so no page is frozen with the words of build time and a build
// needs no database.
export const pageCopy: () => Promise<Copy> = cache(async () => {
  await connection();
  return readCopy();
});
