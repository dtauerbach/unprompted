"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

// What a page sends when its person has just posted, so the chat around it
// looks for an answer often for a while (LiveRefresh) and scrolls to it.
export const POSTED_EVENT = "unprompted:posted";

export function announcePosted() {
  window.dispatchEvent(new Event(POSTED_EVENT));
}

// How long to wait before the next look: often (fastMs) for burstMs after the
// person last posted, since that's when an answer is coming, and seldom
// (slowMs) otherwise. Pure, so a test pins the clock.
export function nextDelay(
  now: number,
  postedAt: number | null,
  { fastMs = 5_000, slowMs = 15_000, burstMs = 120_000 } = {},
): number {
  return postedAt !== null && now - postedAt < burstMs ? fastMs : slowMs;
}

// Reloads a chat page from the server while its tab is visible, so new
// messages show without the person reloading. It reads nothing itself: the
// server reads the page again, as fresh as a reload, with every check a
// reload makes. A hidden tab looks again only once it's back.
export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    let postedAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(look, nextDelay(Date.now(), postedAt));
    };
    const look = () => {
      if (document.visibilityState === "visible") router.refresh();
      schedule();
    };
    const posted = () => {
      postedAt = Date.now();
      schedule();
    };
    const back = () => {
      if (document.visibilityState === "visible") look();
    };
    window.addEventListener(POSTED_EVENT, posted);
    document.addEventListener("visibilitychange", back);
    schedule();
    return () => {
      clearTimeout(timer);
      window.removeEventListener(POSTED_EVENT, posted);
      document.removeEventListener("visibilitychange", back);
    };
  }, [router]);
  return null;
}

// Keeps a chat scrolled to its newest message: on first load, after the
// person posts, and when a new message arrives while they were already at
// the bottom. Someone scrolled up to read stays where they are.
export function ScrollToEnd({ last }: { last: number | null }) {
  const end = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const first = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      const gap =
        document.documentElement.scrollHeight -
        (window.scrollY + window.innerHeight);
      atBottom.current = gap < 160;
    };
    const posted = () => {
      atBottom.current = true;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener(POSTED_EVENT, posted);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener(POSTED_EVENT, posted);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the newest message changes
  useEffect(() => {
    if (first.current || atBottom.current)
      end.current?.scrollIntoView({ block: "end" });
    first.current = false;
  }, [last]);
  return <div ref={end} aria-hidden="true" />;
}
