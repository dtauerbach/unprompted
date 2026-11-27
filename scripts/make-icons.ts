// Draws the home-screen icons from public/logo.svg. Run it again after the
// logo changes and commit what it writes: `npx tsx scripts/make-icons.ts`.
// sharp comes with Next, so this adds no dependency; nothing at run time
// imports it, since the icons are plain files in public/.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const PUBLIC = join(import.meta.dirname, "..", "public");
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

// `scale` is how much of the square the logo fills. A maskable icon keeps
// the logo inside the middle circle that every platform's mask leaves
// showing (80% of the side), so it gets the most room; iOS rounds the
// corners of a touch icon itself, so that one fills more.
const ICONS = [
  { file: "icon-192.png", size: 192, scale: 1, background: null },
  { file: "icon-512.png", size: 512, scale: 1, background: null },
  { file: "icon-maskable-512.png", size: 512, scale: 0.56, background: WHITE },
  { file: "apple-touch-icon.png", size: 180, scale: 0.86, background: WHITE },
] as const;

async function main() {
  const svg = await readFile(join(PUBLIC, "logo.svg"));
  for (const icon of ICONS) {
    const inner = Math.round(icon.size * icon.scale);
    const logo = await sharp(svg, { density: 72 * (inner / 32) * 2 })
      .resize(inner, inner)
      .png()
      .toBuffer();
    const pad = Math.floor((icon.size - inner) / 2);
    await sharp({
      create: {
        width: icon.size,
        height: icon.size,
        channels: 4,
        background: icon.background ?? { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: logo, top: pad, left: pad }])
      .png({ compressionLevel: 9 })
      .toFile(join(PUBLIC, icon.file));
    console.log(`wrote public/${icon.file}`);
  }
}

await main();
