import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateMetadata, viewport } from "@/app/layout";
import manifest, { ICON_FILES } from "@/app/manifest";
import { pageCopy } from "@/lib/page-copy";
import { resetDb } from "./helpers";

// W1: a person puts the site on their phone's home screen and it opens as an
// app of its own, on their page. The manifest's words are the copy store's,
// and every icon it names is a real PNG of the size it says.

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "unprompted.test" }),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));

beforeEach(resetDb);

const PUBLIC = join(__dirname, "..", "..", "public");

// A PNG's width, height and RGBA pixels, read with no image library: the
// icons are 8-bit RGBA, non-interlaced, as scripts/make-icons.ts writes them.
function readPng(file: string) {
  const buf = readFileSync(join(PUBLIC, file));
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8], `${file}: bit depth`).toBe(8);
      expect(data[9], `${file}: colour type RGBA`).toBe(6);
      expect(data[12], `${file}: not interlaced`).toBe(0);
    }
    if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= 4 ? (px[y * stride + x - 4] ?? 0) : 0;
      const up = y > 0 ? (px[(y - 1) * stride + x] ?? 0) : 0;
      const ul = x >= 4 && y > 0 ? (px[(y - 1) * stride + x - 4] ?? 0) : 0;
      let out = v;
      if (filter === 1) out = v + left;
      else if (filter === 2) out = v + up;
      else if (filter === 3) out = v + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        out = v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      }
      px[y * stride + x] = out & 0xff;
    }
  }
  const at4 = (x: number, y: number, c: number) =>
    px[y * stride + x * 4 + c] ?? 0;
  const alpha = (x: number, y: number) => at4(x, y, 3);
  const isWhite = (x: number, y: number) =>
    at4(x, y, 0) === 255 && at4(x, y, 1) === 255 && at4(x, y, 2) === 255;
  return { width, height, alpha, isWhite };
}

describe("the site as an app on a home screen", () => {
  it("names itself in the copy store's words and opens on the person's page", async () => {
    const t = await pageCopy();
    const m = await manifest();
    expect(m.name).toBe(t["site.name"]);
    expect(m.short_name).toBe(t["site.name"]);
    expect(m.description).toBe(t["site.description"]);
    expect(m.start_url).toBe("/account");
    expect(m.scope).toBe("/");
    expect(m.id).toBe("/");
    expect(m.display).toBe("standalone");
    // Chrome asks for a 192 and a 512 before it offers to install.
    const sizes = (m.icons ?? []).map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(
      expect.arrayContaining([
        "192x192:any",
        "512x512:any",
        "512x512:maskable",
      ]),
    );
    for (const icon of m.icons ?? []) expect(icon.type).toBe("image/png");
  });

  it("names only icons that are real PNGs of the size it says", () => {
    for (const icon of ICON_FILES) {
      const { width, height } = readPng(icon.src.slice(1));
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
    }
  });

  it("fills a maskable icon and the iPhone's to the corners, so no mask shows a gap", () => {
    for (const [file, size] of [
      ["icon-maskable-512.png", 512],
      ["apple-touch-icon.png", 180],
    ] as const) {
      const png = readPng(file);
      expect(png.width).toBe(size);
      for (const [x, y] of [
        [0, 0],
        [size - 1, 0],
        [0, size - 1],
        [size - 1, size - 1],
      ] as const)
        expect(png.alpha(x, y), `${file} at ${x},${y}`).toBe(255);
    }
    // The plain icons keep the logo's own rounded corners.
    const plain = readPng("icon-512.png");
    expect(plain.alpha(0, 0)).toBe(0);
    expect(plain.alpha(256, 256)).toBe(255);
  });

  it("keeps the maskable logo inside the circle every mask leaves showing", () => {
    // Every platform's mask leaves at least a circle of 40% of the side
    // around the middle; outside it a maskable icon may hold only its
    // background, or a mask would cut the logo.
    const png = readPng("icon-maskable-512.png");
    const r = 512 * 0.4;
    let logo = 0;
    for (let y = 0; y < 512; y++)
      for (let x = 0; x < 512; x++) {
        const outside = Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > r;
        if (outside) expect(png.isWhite(x, y), `${x},${y}`).toBe(true);
        else if (!png.isWhite(x, y)) logo++;
      }
    // And the logo is there.
    expect(logo).toBeGreaterThan(1000);
  });

  it("tells an iPhone to open it as an app, with its icon and the site's name", async () => {
    const t = await pageCopy();
    const meta = await generateMetadata();
    expect(meta.appleWebApp).toEqual({ capable: true, title: t["site.name"] });
    expect(meta.icons).toMatchObject({ apple: "/apple-touch-icon.png" });
    const { width } = readPng("apple-touch-icon.png");
    expect(width).toBe(180);
  });

  it("colours the bar above the page like the header, in either scheme", () => {
    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#ffffff" },
      { media: "(prefers-color-scheme: dark)", color: "#171717" },
    ]);
  });
});
