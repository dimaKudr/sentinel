import type { SentinelConfig, WatchlistGroup } from "./config";
import { CANONICAL_WATCHLIST_GROUPS } from "./config";

export type SheetRow = string[];

interface SheetsValuesResponse {
  values?: SheetRow[];
}

export interface WatchListMatch {
  ticker: string;
  target: number;
  pv: number;
  group: WatchlistGroup;
}

/**
 * Reads all values for the configured tab. The Sheets API `values.get`
 * response starts at A1 (index 0), regardless of where the header row
 * actually lives in the spreadsheet -- `filterRows` below is responsible
 * for skipping down to `CONFIG.HEADER_ROW`.
 */
export async function getSheetValues(
  token: string,
  fileId: string,
  tab: string
): Promise<SheetRow[]> {
  const range = encodeURIComponent(tab);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${range}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await resp.json()) as SheetsValuesResponse;

  if (!data.values) {
    throw new Error(`No values returned from sheet: ${JSON.stringify(data)}`);
  }
  return data.values;
}

/**
 * Strips currency symbols/commas/whitespace before parsing (e.g. "$1,234.56" -> 1234.56).
 * Note: does not handle accounting-style negatives like "(123.45)" -- the brief only
 * specifies "$123.45"/"1,234.56" style values, so that's left unhandled for now.
 */
export function parseNumber(value: unknown): number {
  if (typeof value !== "string") {
    return typeof value === "number" ? value : Number(value);
  }
  const cleaned = value.replace(/[^0-9.\-]/g, "");
  return cleaned === "" ? NaN : Number(cleaned);
}

/**
 * Resolves a raw `Watchlist` cell value to one of the 3 canonical groups
 * via a trimmed, case-insensitive match, or `"Other"` for anything else
 * (blank, typo'd, or otherwise unrecognized). `"Other"` is a deliberate
 * catch-all -- it surfaces likely data-entry problems in the sheet rather
 * than silently dropping the row.
 */
function resolveWatchlistGroup(rawValue: string | undefined): WatchlistGroup {
  const normalized = (rawValue ?? "").trim().toLowerCase();
  const canonical = CANONICAL_WATCHLIST_GROUPS.find((g) => g.toLowerCase() === normalized);
  return canonical ?? "Other";
}

/**
 * Filters sheet rows to those where Target > PV $ and WallSt > PV $,
 * resolving column positions by (case-insensitive, trimmed) header name
 * rather than fixed index. A row with an unparseable WallSt value isn't
 * excluded by that rule -- there's nothing to compare, so it falls back
 * to just the Target > PV $ check.
 *
 * Each match is tagged with its resolved `Watchlist` group (see
 * `resolveWatchlistGroup`). The `Watchlist` header itself must exist in the
 * sheet (missing header throws, same as the other configured columns) --
 * only an individual row's *value* not matching a canonical name falls
 * back to `"Other"` rather than throwing.
 *
 * `rows` is the raw values.get response, which is always anchored at A1.
 * The real header row lives at `config.HEADER_ROW` (1-based), so the header
 * row within `rows` is at array index `config.HEADER_ROW - 1`, and data
 * rows are everything after it. If the caller already trimmed `rows` down
 * to start at the header row (e.g. by requesting a range starting at that
 * row), pass `rowsStartAtHeaderRow: true` to treat index 0 as the header.
 */
export function filterRows(
  rows: SheetRow[],
  config: Pick<
    SentinelConfig,
    "HEADER_ROW" | "TICKER_COL" | "TARGET_COL" | "PV_COL" | "WALLST_COL" | "WATCHLIST_COL"
  >,
  options: { rowsStartAtHeaderRow?: boolean } = {}
): WatchListMatch[] {
  const headerIndex = options.rowsStartAtHeaderRow ? 0 : config.HEADER_ROW - 1;
  const headerRow = rows[headerIndex];
  if (!headerRow) {
    throw new Error(
      `Sheet has no row ${config.HEADER_ROW} (expected headers there); only ${rows.length} row(s) were returned`
    );
  }

  const headers = headerRow.map((h) => (h ?? "").trim().toLowerCase());
  const indexOf = (name: string): number => headers.indexOf(name.trim().toLowerCase());

  const tickerIdx = indexOf(config.TICKER_COL);
  const targetIdx = indexOf(config.TARGET_COL);
  const pvIdx = indexOf(config.PV_COL);
  const wallStIdx = indexOf(config.WALLST_COL);
  const watchlistIdx = indexOf(config.WATCHLIST_COL);

  if (
    tickerIdx === -1 ||
    targetIdx === -1 ||
    pvIdx === -1 ||
    wallStIdx === -1 ||
    watchlistIdx === -1
  ) {
    throw new Error(
      `Configured column(s) not found. Sheet headers were: [${headerRow.join(", ")}]`
    );
  }

  const results: WatchListMatch[] = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const target = parseNumber(row[targetIdx]);
    const pv = parseNumber(row[pvIdx]);
    if (Number.isNaN(target) || Number.isNaN(pv) || target <= pv) continue;

    const wallSt = parseNumber(row[wallStIdx]);
    if (!Number.isNaN(wallSt) && wallSt <= pv) continue;

    results.push({
      ticker: row[tickerIdx] ?? "",
      target,
      pv,
      group: resolveWatchlistGroup(row[watchlistIdx]),
    });
  }
  return results;
}

/**
 * Buckets matches by their resolved `Watchlist` group, preserving
 * `GROUP_ORDER` (Core -> Opportunities -> Speculative -> Other) as the key
 * order so downstream iteration doesn't need to re-sort.
 */
export function groupMatchesByWatchlist(
  matches: WatchListMatch[]
): Record<WatchlistGroup, WatchListMatch[]> {
  const grouped: Record<WatchlistGroup, WatchListMatch[]> = {
    Core: [],
    Opportunities: [],
    Speculative: [],
    Other: [],
  };
  for (const match of matches) {
    grouped[match.group].push(match);
  }
  return grouped;
}
