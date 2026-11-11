// A stand-in for next/cache in tests, which run outside Next, where the real
// unstable_cache has no cache to keep things in. It keeps entries the way
// Next does for what the site uses: by key parts and arguments, as JSON, for
// `revalidate` seconds, until a tag on them is cleared. setup.ts puts it in
// place for every test file.

type Entry = { json: string; tags: string[]; until: number };

const entries = new Map<string, Entry>();

export const cacheCalls = {
  updateTag: [] as string[],
  revalidateTag: [] as { tag: string; profile: unknown }[],
  revalidatePath: [] as string[],
};

// The clock entries expire by, which a test may move on.
export const cacheClock = { now: () => Date.now() };

export function resetNextCache(): void {
  entries.clear();
  cacheCalls.updateTag.length = 0;
  cacheCalls.revalidateTag.length = 0;
  cacheCalls.revalidatePath.length = 0;
}

export function cachedKeys(): string[] {
  return [...entries.keys()];
}

export function unstable_cache<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  keyParts: string[] = [],
  opts: { tags?: string[]; revalidate?: number | false } = {},
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const key = JSON.stringify([keyParts, args]);
    const hit = entries.get(key);
    if (hit && hit.until > cacheClock.now()) return JSON.parse(hit.json);
    // A throw keeps nothing, as in Next.
    const value = await fn(...args);
    const seconds = opts.revalidate || 365 * 24 * 3600;
    entries.set(key, {
      json: JSON.stringify(value),
      tags: opts.tags ?? [],
      until: cacheClock.now() + seconds * 1000,
    });
    return JSON.parse(JSON.stringify(value));
  };
}

function clear(tag: string): void {
  for (const [key, e] of entries) if (e.tags.includes(tag)) entries.delete(key);
}

export function updateTag(tag: string): void {
  cacheCalls.updateTag.push(tag);
  clear(tag);
}

export function revalidateTag(tag: string, profile: unknown): void {
  cacheCalls.revalidateTag.push({ tag, profile });
  clear(tag);
}

export function revalidatePath(path: string): void {
  cacheCalls.revalidatePath.push(path);
}
