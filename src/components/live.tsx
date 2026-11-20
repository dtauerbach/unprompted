"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

// What a page sends when its person has just posted, so the chat around it
// looks for an answer often for a while (LiveRefresh) and scrolls to it.
export const POSTED_EVENT = "unprompted:posted";

export function announcePosted() {
  window.dispatchEvent(new Event(POSTED_EVENT));
}

// How long to wait before the next look, or null to stop looking: often
// (fastMs) for burstMs after the person last posted, since that's when an
// answer is coming; every slowMs while anything happened (a post, a new
// message, the tab coming back) in the last quietMs; every idleMs after
// that; and not at all once nothing has happened for stopMs, until the
// person comes back to the tab or posts. So a tab left open overnight
// stops reading the database. Pure, so a test pins the clock.
export function nextDelay(
  now: number,
  activeAt: number,
  postedAt: number | null,
  {
    fastMs = 5_000,
    slowMs = 15_000,
    idleMs = 60_000,
    burstMs = 120_000,
    quietMs = 300_000,
    stopMs = 1_800_000,
  } = {},
): number | null {
  if (postedAt !== null && now - postedAt < burstMs) return fastMs;
  const still = now - activeAt;
  if (still < quietMs) return slowMs;
  if (still < stopMs) return idleMs;
  return null;
}

// Reloads a chat page from the server while its tab is visible, so new
// messages show without the person reloading. It reads nothing itself: the
// server reads the page again, as fresh as a reload, with every check a
// reload makes, and a refresh that lands on a page without this (signed
// out, no longer theirs) ends it. A hidden tab looks again only once it's
// back. `last` is the newest message's id: when it changes, something
// happened, and the page keeps looking often.
export function LiveRefresh({ last }: { last: number | null }) {
  const router = useRouter();
  const activeAt = useRef(Date.now());
  const wake = useRef<() => void>(() => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the newest message changes
  useEffect(() => {
    activeAt.current = Date.now();
    wake.current();
  }, [last]);
  useEffect(() => {
    let postedAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Coming back to the tab fires both focus and visibilitychange: look
    // once, and not again within a couple of seconds of the last look.
    let lookedAt = 0;
    const schedule = () => {
      clearTimeout(timer);
      const wait = nextDelay(Date.now(), activeAt.current, postedAt);
      if (wait !== null) timer = setTimeout(look, wait);
    };
    const look = () => {
      if (document.visibilityState === "visible") {
        lookedAt = Date.now();
        router.refresh();
      }
      schedule();
    };
    const posted = () => {
      postedAt = Date.now();
      activeAt.current = postedAt;
      schedule();
    };
    const back = () => {
      if (document.visibilityState !== "visible") return;
      activeAt.current = Date.now();
      if (activeAt.current - lookedAt < 2_000) return schedule();
      look();
    };
    wake.current = schedule;
    window.addEventListener(POSTED_EVENT, posted);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    schedule();
    return () => {
      clearTimeout(timer);
      wake.current = () => {};
      window.removeEventListener(POSTED_EVENT, posted);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [router]);
  return null;
}

// Whether the newest message is in view, or close to it: its end marker's
// bottom is within slackPx of the top of the compose box, or of the visible
// area's bottom (viewBottom, in the marker's coordinates) when there's no box. Measured against the marker rather than
// the document, so the compose box and footer below it don't count as being
// away from the end. Pure, so a test pins the numbers.
export function nearEnd(
  endBottom: number,
  viewBottom: number,
  composeHeight: number,
  slackPx = 160,
): boolean {
  return endBottom - (viewBottom - composeHeight) < slackPx;
}

// The pinned compose box, if this page has one (data-compose), and its height.
function composeHeight(): number {
  const box = document.querySelector<HTMLElement>("[data-compose]");
  return box ? box.getBoundingClientRect().height : 0;
}

// Whether a shrink of the visible area is a phone's keyboard opening for the
// compose box, not the address bar coming back or a pinch-zoom: it shrank by
// a keyboard's height from its tallest since the last scroll (so a keyboard
// that slides up in several steps still counts), at no zoom, while the person
// is typing in the box. Pure, so a test pins the numbers.
export function keyboardOpened(
  tallest: number,
  after: number,
  scale: number,
  composing: boolean,
  minPx = 120,
): boolean {
  return composing && Math.abs(scale - 1) < 0.01 && tallest - after > minPx;
}

// The bottom of what's visible, in the same coordinates as
// getBoundingClientRect: on a phone with the keyboard up, or when zoomed in,
// that's the visual viewport's bottom (its offset plus its height), which can
// sit above the window's.
function viewBottom(): number {
  const v = window.visualViewport;
  return v ? v.offsetTop + v.height : window.innerHeight;
}

// Whether the person is typing in the pinned compose box.
function composing(): boolean {
  const active = document.activeElement;
  return !!active?.closest("[data-compose]");
}

// Keeps a chat scrolled to its newest message: on first load (unless the
// address names one message), after the person posts, when a new message
// arrives while they were already at the bottom, when a phone's keyboard
// opens for the compose box, and when the box grows with a long draft, while
// they were. The newest message lands just above the pinned compose box, not
// under it. Someone scrolled up to read stays where they are, and the address
// bar coming and going or a pinch-zoom never moves them.
export function ScrollToEnd({ last }: { last: number | null }) {
  const end = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const first = useRef(true);
  const toEnd = useRef<() => void>(() => {});
  useEffect(() => {
    toEnd.current = () => {
      const el = end.current;
      if (!el) return;
      el.style.scrollMarginBottom = `${Math.ceil(composeHeight()) + 8}px`;
      el.scrollIntoView({ block: "end" });
    };
    const onScroll = () => {
      const el = end.current;
      if (!el) return;
      atBottom.current = nearEnd(
        el.getBoundingClientRect().bottom,
        viewBottom(),
        composeHeight(),
      );
    };
    const posted = () => {
      atBottom.current = true;
    };
    const v = window.visualViewport;
    // The tallest the visible area has been since the last keyboard scroll:
    // raised whenever it grows, brought down only once the keyboard counted.
    let tallest = v?.height ?? 0;
    const resized = () => {
      if (!v) return;
      if (v.height > tallest) tallest = v.height;
      else if (keyboardOpened(tallest, v.height, v.scale, composing())) {
        tallest = v.height;
        if (atBottom.current) toEnd.current();
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener(POSTED_EVENT, posted);
    v?.addEventListener("resize", resized);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener(POSTED_EVENT, posted);
      v?.removeEventListener("resize", resized);
    };
  }, []);
  // The compose box grows with a long draft; keep the newest message above
  // it. Looked for on every refresh, since the box can first appear on one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: looks again when the newest message changes
  useEffect(() => {
    const box = document.querySelector<HTMLElement>("[data-compose]");
    if (!box || typeof ResizeObserver === "undefined") return;
    let boxHeight = box.getBoundingClientRect().height;
    const grew = new ResizeObserver(() => {
      const h = box.getBoundingClientRect().height;
      const bigger = h > boxHeight;
      boxHeight = h;
      if (bigger && atBottom.current) toEnd.current();
    });
    grew.observe(box);
    return () => grew.disconnect();
  }, [last]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the newest message changes
  useEffect(() => {
    // A link to one message (#m<id>) lands on it, not at the end.
    const linked = first.current && /^#m\d+$/.test(window.location.hash);
    if (linked) atBottom.current = false;
    else if (first.current || atBottom.current) toEnd.current();
    first.current = false;
  }, [last]);
  return <div ref={end} aria-hidden="true" />;
}
