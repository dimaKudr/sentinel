/**
 * Config surface -- edit these to match your actual spreadsheet.
 *
 * Column matching (see src/sheets.ts) is case-insensitive and
 * whitespace-trimmed, but otherwise exact.
 */
export interface RunWindow {
  /** Local hour (Europe/Prague), inclusive. */
  startHour: number;
  /** Local hour (Europe/Prague), inclusive. */
  endHour: number;
}

export interface SentinelConfig {
  /** Exact Drive file name (looked up by name, not file ID -- see src/drive.ts). */
  FILE_NAME: string;
  /** Exact tab name inside the spreadsheet. */
  SHEET_TAB: string;
  /**
   * 1-based row number that contains the column headers. The sheet's
   * real data starts on the row directly below this one.
   */
  HEADER_ROW: number;
  TICKER_COL: string;
  TARGET_COL: string;
  PV_COL: string;
  WALLST_COL: string;
  WATCHLIST_COL: string;
  RUN_WINDOW: RunWindow;
}

export const CONFIG: SentinelConfig = {
  FILE_NAME: "Watch-List",
  SHEET_TAB: "Board",
  HEADER_ROW: 3,
  TICKER_COL: "Ticker",
  TARGET_COL: "Target",
  PV_COL: "PV $",
  WALLST_COL: "WallSt",
  WATCHLIST_COL: "Watchlist",
  RUN_WINDOW: { startHour: 16, endHour: 21 },
};

/** IANA timezone the run window and displayed timestamps are evaluated in. */
export const TIME_ZONE = "Europe/Prague";

/**
 * The 3 canonical watch-list buckets a row's `Watchlist` cell can resolve
 * to (case-insensitive, trimmed match -- see `filterRows` in src/sheets.ts).
 * Anything else (blank, typo, unrecognized) falls back to `"Other"`, which
 * isn't part of this list since it's never gated by the per-group publish
 * suppression in src/state.ts.
 */
export const CANONICAL_WATCHLIST_GROUPS = ["Core", "Opportunities", "Speculative"] as const;

export type CanonicalWatchlistGroup = (typeof CANONICAL_WATCHLIST_GROUPS)[number];

/** A row's resolved group, including the catch-all bucket. */
export type WatchlistGroup = CanonicalWatchlistGroup | "Other";

/** Fixed rendering/iteration order for the Telegram message: Core -> Opportunities -> Speculative -> Other. */
export const GROUP_ORDER: readonly WatchlistGroup[] = [...CANONICAL_WATCHLIST_GROUPS, "Other"];
