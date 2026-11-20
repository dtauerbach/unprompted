import { describe, expect, it } from "vitest";
import { keyboardOpened, nearEnd, nextDelay } from "@/components/live";
import { RUN_GAP_MS, type SeenInput, seenKind, startsRun } from "@/lib/chat";

// The pure parts of a person's chat page: which messages show their
// writer's line, and how soon the page looks again.

const at = (min: number) => new Date(Date.UTC(2026, 10, 19, 21, min));

describe("runs of messages", () => {
  it("starts a run at the first message, a new writer, or a long gap", () => {
    expect(startsRun(undefined, { from: "lea", created_at: at(0) })).toBe(true);
    const lea = { from: "lea", created_at: at(0) };
    expect(startsRun(lea, { from: "lea", created_at: at(9) })).toBe(false);
    expect(startsRun(lea, { from: "lea", created_at: at(10) })).toBe(true);
    expect(startsRun(lea, { from: "ben", created_at: at(1) })).toBe(true);
    // The person reading (from null) is a writer of their own.
    expect(startsRun(lea, { from: null, created_at: at(1) })).toBe(true);
    const you = { from: null, created_at: at(0) };
    expect(startsRun(you, { from: null, created_at: at(1) })).toBe(false);
    expect(RUN_GAP_MS).toBe(600_000);
  });
});

describe("whether the person is at the newest message", () => {
  it("measures from the top of the compose box, not the bottom of the page", () => {
    // An 800px screen with a 130px compose box: the newest message's end
    // just above the box is at the end, as is anything within 160px of it.
    expect(nearEnd(670, 800, 130)).toBe(true);
    expect(nearEnd(829, 800, 130)).toBe(true);
    expect(nearEnd(830, 800, 130)).toBe(false);
    // Scrolled well up, the end is far below what's visible.
    expect(nearEnd(2000, 800, 130)).toBe(false);
    // With the keyboard up the visible area is smaller.
    expect(nearEnd(390, 400, 130)).toBe(true);
    expect(nearEnd(390, 300, 130)).toBe(false);
    // No compose box: measured from the bottom of what's visible.
    expect(nearEnd(959, 800, 0)).toBe(true);
    expect(nearEnd(960, 800, 0)).toBe(false);
    expect(nearEnd(100, 800, 0, 10)).toBe(true);
    // iOS with the keyboard up: the visible area is 500px tall, panned 300px
    // down the 800px window, so its bottom is at 800 in the marker's
    // coordinates; the newest message just above the box is still at the end.
    expect(nearEnd(660, 300 + 500, 130)).toBe(true);
    expect(nearEnd(660, 500, 130)).toBe(false);
  });

  it("follows a keyboard opening for the compose box, not the address bar or a zoom", () => {
    // The keyboard: a big shrink, no zoom, typing in the box.
    expect(keyboardOpened(800, 450, 1, true)).toBe(true);
    // The address bar coming back: a small shrink.
    expect(keyboardOpened(800, 740, 1, true)).toBe(false);
    expect(keyboardOpened(800, 680, 1, true)).toBe(false);
    expect(keyboardOpened(800, 679, 1, true)).toBe(true);
    // Zoomed in, or not typing in the box: never.
    expect(keyboardOpened(800, 400, 2, true)).toBe(false);
    expect(keyboardOpened(800, 450, 1, false)).toBe(false);
    // Growing back (the keyboard closing) never scrolls.
    expect(keyboardOpened(450, 800, 1, true)).toBe(false);
    // Measured from the tallest, so a keyboard sliding up in steps counts
    // once the steps add up (800, then 720, 620, 500: 180 below 800).
    expect(keyboardOpened(800, 720, 1, true)).toBe(false);
    expect(keyboardOpened(800, 620, 1, true)).toBe(true);
    // A scale a hair off 1 is still no zoom.
    expect(keyboardOpened(800, 450, 1.0000001, true)).toBe(true);
    expect(keyboardOpened(800, 450, 0.999, true)).toBe(true);
    expect(keyboardOpened(800, 450, 1.05, true)).toBe(false);
  });
});

describe("how soon the chat looks again", () => {
  it("looks often for two minutes after the person posts, then less, then stops", () => {
    const now = 10_000_000;
    // Something just happened, no post: every 15 seconds.
    expect(nextDelay(now, now, null)).toBe(15_000);
    // Right after a post: every 5 seconds, for two minutes.
    expect(nextDelay(now, now, now)).toBe(5_000);
    expect(nextDelay(now, now, now - 119_999)).toBe(5_000);
    expect(nextDelay(now, now - 120_000, now - 120_000)).toBe(15_000);
    // Quiet for five minutes: once a minute.
    expect(nextDelay(now, now - 299_999, null)).toBe(15_000);
    expect(nextDelay(now, now - 300_000, null)).toBe(60_000);
    // Quiet for half an hour: it stops, so an open tab doesn't keep the
    // database awake; coming back or posting starts it again.
    expect(nextDelay(now, now - 1_799_999, null)).toBe(60_000);
    expect(nextDelay(now, now - 1_800_000, null)).toBeNull();
    expect(nextDelay(now, now - 1_800_000, now)).toBe(5_000);
    expect(
      nextDelay(now, now - 10, null, { slowMs: 2, quietMs: 5, stopMs: 9 }),
    ).toBeNull();
  });
});

describe("what became of the person's newest message", () => {
  const base: SeenInput = {
    sent_at: at(10),
    answered: false,
    fired_at: null,
    checked_at: null,
    delivered_at: null,
    woken_by_message: true,
    wakeable: true,
  };
  it("goes by the furthest it got: answered, checked in, woken, waiting", () => {
    expect(seenKind(base)).toBe("pending");
    expect(seenKind({ ...base, delivered_at: at(11) })).toBe("woken");
    expect(seenKind({ ...base, fired_at: at(11) })).toBe("woken_unchecked");
    expect(seenKind({ ...base, fired_at: at(11), checked_at: at(12) })).toBe(
      "checked_in",
    );
    expect(seenKind({ ...base, answered: true, checked_at: at(12) })).toBe(
      "answered",
    );
  });
  it("counts nothing from before the message", () => {
    const old = { fired_at: at(9), checked_at: at(9), delivered_at: at(9) };
    expect(seenKind({ ...base, ...old })).toBe("pending");
    expect(seenKind({ ...base, delivered_at: at(10) })).toBe("woken");
  });
  it("says next visit when the message didn't wake it or nothing can", () => {
    expect(seenKind({ ...base, woken_by_message: false })).toBe("next_visit");
    expect(seenKind({ ...base, wakeable: false })).toBe("next_visit");
    // A wake that went anyway, for something else, still shows.
    expect(
      seenKind({ ...base, woken_by_message: false, delivered_at: at(11) }),
    ).toBe("woken");
  });
});
