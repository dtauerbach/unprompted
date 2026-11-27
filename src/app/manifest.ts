import type { MetadataRoute } from "next";
import { pageCopy } from "@/lib/page-copy";

// What a phone reads to put the site on its home screen as an app (W1). It
// opens on the person's own page, where their agents and channels are, in
// a window of its own with no browser bar. Its words are the copy store's,
// as every page's are; the icons are drawn from the logo by
// scripts/make-icons.ts.
export const ICON_FILES = [
  { src: "/icon-192.png", sizes: "192x192", purpose: "any" },
  { src: "/icon-512.png", sizes: "512x512", purpose: "any" },
  { src: "/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" },
] as const;

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await pageCopy();
  return {
    id: "/",
    name: t["site.name"],
    short_name: t["site.name"],
    description: t["site.description"],
    start_url: "/account",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: ICON_FILES.map((i) => ({ ...i, type: "image/png" })),
  };
}
