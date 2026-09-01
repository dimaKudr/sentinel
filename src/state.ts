import type { WatchListMatch } from "./sheets";
import { TIME_ZONE } from "./config";

const STATE_KEY = "last-published";
const CHANGE_THRESHOLD = 0.01; // 1%

interface StoredState {
  /** Europe/Prague calendar date (YYYY-MM-DD) of the last publish. */
  date: string;
  /** PV per ticker as of the last publish. */
  pv: Record<string, number>;
}

function todayInTimeZone(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

async function readState(kv: KVNamespace): Promise<StoredState | null> {
  return kv.get<StoredState>(STATE_KEY, "json");
}

async function writeState(kv: KVNamespace, state: StoredState): Promise<void> {
  await kv.put(STATE_KEY, JSON.stringify(state));
}

function pvByTicker(matches: WatchListMatch[]): Record<string, number> {
  const pv: Record<string, number> = {};
  for (const m of matches) pv[m.ticker] = m.pv;
  return pv;
}

/**
 * Decides whether `matches` are worth publishing, and updates the stored
 * state to the current PVs when they are.
 *
 * Rules:
 * - No current matches always publishes (reports the list going clear).
 * - The first publish of the calendar day (Europe/Prague) always goes out,
 *   regardless of how small the change is.
 * - Otherwise, all-or-nothing: the whole alert is skipped only when every
 *   matching ticker's PV is within 1% of what was last published for it. A
 *   brand new ticker, or any PV move past that threshold, publishes the lot.
 *
 * Suppressed runs don't touch the stored state, so the 1% threshold stays
 * anchored to the last value actually published (no slow drift).
 */
export async function shouldPublish(
  kv: KVNamespace,
  matches: WatchListMatch[],
  now: Date = new Date()
): Promise<boolean> {
  const today = todayInTimeZone(now);

  if (matches.length === 0) {
    await writeState(kv, { date: today, pv: {} });
    return true;
  }

  const previous = await readState(kv);
  const isFirstPublishToday = previous?.date !== today;

  const changed =
    isFirstPublishToday ||
    matches.some((m) => {
      const prevPv = previous?.pv[m.ticker];
      if (prevPv === undefined || prevPv === 0) return true;
      return Math.abs(m.pv - prevPv) / prevPv > CHANGE_THRESHOLD;
    });

  if (!changed) return false;

  await writeState(kv, { date: today, pv: pvByTicker(matches) });
  return true;
}

/**
 * Unconditionally records `matches` as the last-published state, without
 * deciding whether to publish. Used when a publish is forced (e.g. the
 * manual `/run?force=true` route) so the 1% threshold still anchors to
 * this run's values instead of going stale.
 */
export async function recordPublished(
  kv: KVNamespace,
  matches: WatchListMatch[],
  now: Date = new Date()
): Promise<void> {
  await writeState(kv, { date: todayInTimeZone(now), pv: pvByTicker(matches) });
}
