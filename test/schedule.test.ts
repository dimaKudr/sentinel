import { describe, expect, it } from "vitest";
import { isWithinRunWindow } from "../src/schedule";
import type { RunWindow } from "../src/config";

const WINDOW: RunWindow = { startHour: 16, endHour: 21 };
const TZ = "Europe/Prague";

// Helper: builds a UTC instant that corresponds to a given Europe/Prague
// wall-clock hour on a fixed midweek/weekend date, accounting for the
// +2h summer / +1h winter offset so tests are DST-agnostic by construction.
function pragueInstant(isoDateUtcMidnight: string, localHour: number, utcOffsetHours: number): Date {
  const base = new Date(isoDateUtcMidnight);
  base.setUTCHours(localHour - utcOffsetHours, 0, 0, 0);
  return base;
}

describe("isWithinRunWindow", () => {
  // 2026-08-31 is a Monday, Europe/Prague is UTC+2 (CEST) in late August.
  const MONDAY_SUMMER = "2026-08-31T00:00:00Z";
  const CEST_OFFSET = 2;

  it("returns true at the start boundary hour (16, inclusive)", () => {
    const now = pragueInstant(MONDAY_SUMMER, 16, CEST_OFFSET);
    expect(isWithinRunWindow(now, WINDOW, TZ)).toBe(true);
  });

  it("returns true at the end boundary hour (21, inclusive)", () => {
    const now = pragueInstant(MONDAY_SUMMER, 21, CEST_OFFSET);
    expect(isWithinRunWindow(now, WINDOW, TZ)).toBe(true);
  });

  it("returns false just before the window (15)", () => {
    const now = pragueInstant(MONDAY_SUMMER, 15, CEST_OFFSET);
    expect(isWithinRunWindow(now, WINDOW, TZ)).toBe(false);
  });

  it("returns false just after the window (22)", () => {
    const now = pragueInstant(MONDAY_SUMMER, 22, CEST_OFFSET);
    expect(isWithinRunWindow(now, WINDOW, TZ)).toBe(false);
  });

  it("returns true mid-window on a weekday", () => {
    const now = pragueInstant(MONDAY_SUMMER, 18, CEST_OFFSET);
    expect(isWithinRunWindow(now, WINDOW, TZ)).toBe(true);
  });

  it("returns false on Saturday, even inside the hour window", () => {
    // 2026-09-05 is a Saturday.
    const now = pragueInstant("2026-09-05T00:00:00Z", 18, CEST_OFFSET);
    expect(isWithinRunWindow(now, WINDOW, TZ)).toBe(false);
  });

  it("returns false on Sunday, even inside the hour window", () => {
    // 2026-09-06 is a Sunday.
    const now = pragueInstant("2026-09-06T00:00:00Z", 18, CEST_OFFSET);
    expect(isWithinRunWindow(now, WINDOW, TZ)).toBe(false);
  });

  it("stays correct across the DST changeover (winter offset is +1h)", () => {
    // 2026-11-02 is a Monday in winter (CET, UTC+1).
    const now = pragueInstant("2026-11-02T00:00:00Z", 18, 1);
    expect(isWithinRunWindow(now, WINDOW, TZ)).toBe(true);
  });
});
