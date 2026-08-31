import { CONFIG, TIME_ZONE, type RunWindow } from "./config";

const WEEKEND_DAYS = new Set(["Sat", "Sun"]);

/**
 * DST-safe run-window check.
 *
 * The Worker fires hourly via cron every day of the week; this function
 * decides -- using IANA timezone conversion rather than a hardcoded UTC
 * offset -- whether "now" falls inside the configured Mon-Fri local-time
 * window. Because it re-derives the local hour/weekday from `now` on every
 * invocation, it stays correct across DST changeovers without the cron
 * expression ever needing to be edited.
 */
export function isWithinRunWindow(
  now: Date = new Date(),
  window: RunWindow = CONFIG.RUN_WINDOW,
  timeZone: string = TIME_ZONE
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);

  const hourPart = parts.find((p) => p.type === "hour")?.value;
  const weekdayPart = parts.find((p) => p.type === "weekday")?.value;
  if (hourPart === undefined || weekdayPart === undefined) {
    throw new Error("Failed to resolve local time parts for run-window check");
  }

  // Intl.DateTimeFormat with hour12: false can return "24" for midnight in
  // some environments; normalize it to 0 so boundary math stays correct.
  const hour = Number(hourPart) % 24;
  const isWeekday = !WEEKEND_DAYS.has(weekdayPart);

  return isWeekday && hour >= window.startHour && hour <= window.endHour;
}
