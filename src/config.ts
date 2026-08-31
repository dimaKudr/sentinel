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
  RUN_WINDOW: RunWindow;
}

export const CONFIG: SentinelConfig = {
  FILE_NAME: "Watch-List",
  SHEET_TAB: "Board",
  HEADER_ROW: 3,
  TICKER_COL: "Ticker",
  TARGET_COL: "Target",
  PV_COL: "PV $",
  RUN_WINDOW: { startHour: 16, endHour: 21 },
};

/** IANA timezone the run window and displayed timestamps are evaluated in. */
export const TIME_ZONE = "Europe/Prague";
