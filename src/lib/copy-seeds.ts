import { createHash } from "node:crypto";

// A seed's fingerprint in src/lib/copy-seeds.json: enough to tell that the
// words changed, without a second copy of them.
export function seedHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
