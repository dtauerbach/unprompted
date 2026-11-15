// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { LocalTime, localText } from "@/components/local-time";

// The peek-in page's times in a browser: once the browser has taken over,
// a component handed a new instant shows that instant in the very commit
// that hands it over, never the last one it showed until an effect catches
// up (Dot's review of the page, msg 139).

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// What the page shows at each commit, read before any effect of that commit
// runs: a layout effect runs right after the DOM is updated.
const seen: (string | null)[] = [];
function Watch({ iso, at }: { iso: string; at: HTMLElement }) {
  useLayoutEffect(() => {
    seen.push(at.querySelector("time")?.textContent ?? null);
  });
  return createElement(LocalTime, { iso });
}

describe("a time in the browser", () => {
  it("shows the new instant in the reader's zone in the commit that brings it", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    const first = "2026-11-15T18:45:00.000Z";
    const next = "2026-11-16T04:30:00.000Z";
    await act(async () =>
      root.render(createElement(Watch, { iso: first, at: el })),
    );
    const time = () => el.querySelector("time");
    // The first commit is the server's labelled UTC time; the browser's own
    // zone follows once it has loaded.
    expect(seen[0]).toBe("2026-11-15 18:45:00 UTC");
    expect(time()?.textContent).toBe(localText(first));
    seen.length = 0;
    await act(async () =>
      root.render(createElement(Watch, { iso: next, at: el })),
    );
    expect(seen[0]).toBe(localText(next));
    expect(time()?.textContent).toBe(localText(next));
    expect(time()?.getAttribute("dateTime")).toBe(next);
    expect(time()?.getAttribute("title")).toBe("2026-11-16 04:30:00 UTC");
    await act(async () => root.unmount());
  });
});
