import type { WatchListMatch } from "./sheets";
import type { CanonicalWatchlistGroup } from "./config";
import { CANONICAL_WATCHLIST_GROUPS, TIME_ZONE } from "./config";

const STATE_KEY = "last-published";
const CHANGE_THRESHOLD = 0.01; // 1%

interface GroupState {
  /** Europe/Prague calendar date (YYYY-MM-DD) of the group's last publish. */
  date: string;
  /** PV per ticker, within this group, as of the group's last publish. */
  pv: Record<string, number>;
}

/**
 * One KV blob holding all 3 canonical groups' state, keyed by group name.
 * A single key means one atomic get/put per run instead of 3 separate KV
 * reads/writes, avoiding partial-write races between groups. `Other` never
 * appears here -- it's never gated by suppression, so it has no history to
 * anchor (see `decideGroupsToPublish`/`recordGroupsPublished`).
 */
type StoredState = Partial<Record<CanonicalWatchlistGroup, GroupState>>;

async function readState(kv: KVNamespace): Promise<StoredState> {
  return (await kv.get<StoredState>(STATE_KEY, "json")) ?? {};
}

async function writeState(kv: KVNamespace, state: StoredState): Promise<void> {
  await kv.put(STATE_KEY, JSON.stringify(state));
}

function todayInTimeZone(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

function pvByTicker(matches: WatchListMatch[]): Record<string, number> {
  const pv: Record<string, number> = {};
  for (const m of matches) pv[m.ticker] = m.pv;
  return pv;
}

/**
 * A group is "changed" (worth publishing) when it's the first publish of
 * the calendar day (Europe/Prague) for that group, or when any of its
 * current tickers' PV moved past the 1% threshold since that group's last
 * published state (a brand-new ticker counts as a move). Mirrors the
 * previous single-group `shouldPublish` rule, just scoped to one group's
 * own stored state instead of a single global one.
 */
function hasGroupChanged(matches: WatchListMatch[], previous: GroupState | undefined, today: string): boolean {
  const isFirstPublishToday = previous?.date !== today;
  if (isFirstPublishToday) return true;

  return matches.some((m) => {
    const prevPv = previous?.pv[m.ticker];
    if (prevPv === undefined || prevPv === 0) return true;
    return Math.abs(m.pv - prevPv) / prevPv > CHANGE_THRESHOLD;
  });
}

/**
 * Decides, independently per canonical group (Core, Opportunities,
 * Speculative), whether its current matches are worth publishing --
 * and persists updated state only for the groups that are shown.
 *
 * Rules per group (unchanged from the previous single-group behavior,
 * just scoped to that group's own matches/state):
 * - An empty group is never shown, and its state is left untouched (per
 *   decision #4 -- there's nothing to anchor, and no "cleared" notice).
 * - The first publish of the calendar day for that group always shows it.
 * - Otherwise, all-or-nothing per group: skipped only when every one of
 *   the group's tickers' PV is within 1% of what was last published for
 *   it. A brand new ticker, or any PV move past that threshold, shows the
 *   whole group.
 *
 * Groups that aren't shown (whether empty or suppressed) don't have their
 * stored state touched, so the 1% threshold for each stays anchored to the
 * last value actually published for that group (no slow drift).
 */
export async function decideGroupsToPublish(
  kv: KVNamespace,
  matchesByGroup: Record<CanonicalWatchlistGroup, WatchListMatch[]>,
  now: Date = new Date()
): Promise<CanonicalWatchlistGroup[]> {
  const today = todayInTimeZone(now);
  const previous = await readState(kv);

  const toShow: CanonicalWatchlistGroup[] = [];
  const next: StoredState = { ...previous };

  for (const group of CANONICAL_WATCHLIST_GROUPS) {
    const matches = matchesByGroup[group];
    if (matches.length === 0) continue;

    if (!hasGroupChanged(matches, previous[group], today)) continue;

    toShow.push(group);
    next[group] = { date: today, pv: pvByTicker(matches) };
  }

  if (toShow.length > 0) {
    await writeState(kv, next);
  }
  return toShow;
}

/**
 * Unconditionally re-anchors every non-empty canonical group's stored
 * state to its current matches, without deciding whether to show it.
 * Used by the forced path (`/run?force=true`) so each group's 1%
 * threshold anchors to this run's values instead of going stale. Returns
 * the groups that were re-anchored (i.e. currently non-empty), which is
 * also the set the caller should show alongside `Other`.
 */
export async function recordGroupsPublished(
  kv: KVNamespace,
  matchesByGroup: Record<CanonicalWatchlistGroup, WatchListMatch[]>,
  now: Date = new Date()
): Promise<CanonicalWatchlistGroup[]> {
  const today = todayInTimeZone(now);
  const previous = await readState(kv);
  const next: StoredState = { ...previous };

  const nonEmpty: CanonicalWatchlistGroup[] = [];
  for (const group of CANONICAL_WATCHLIST_GROUPS) {
    const matches = matchesByGroup[group];
    if (matches.length === 0) continue;
    nonEmpty.push(group);
    next[group] = { date: today, pv: pvByTicker(matches) };
  }

  if (nonEmpty.length > 0) {
    await writeState(kv, next);
  }
  return nonEmpty;
}
