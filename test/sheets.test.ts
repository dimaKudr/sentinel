import { describe, expect, it } from "vitest";
import { filterRows, parseNumber } from "../src/sheets";
import { CONFIG } from "../src/config";

describe("parseNumber", () => {
  it("parses a plain number string", () => {
    expect(parseNumber("123.45")).toBe(123.45);
  });

  it("strips a leading currency symbol", () => {
    expect(parseNumber("$123.45")).toBe(123.45);
  });

  it("strips thousands separators", () => {
    expect(parseNumber("1,234.56")).toBe(1234.56);
  });

  it("strips currency symbol and commas together", () => {
    expect(parseNumber("$1,234.56")).toBe(1234.56);
  });

  it("parses negative numbers", () => {
    expect(parseNumber("-42.5")).toBe(-42.5);
  });

  it("returns NaN for empty string", () => {
    expect(Number.isNaN(parseNumber(""))).toBe(true);
  });

  it("returns NaN for non-numeric text", () => {
    expect(Number.isNaN(parseNumber("n/a"))).toBe(true);
  });

  it("passes through actual numbers", () => {
    expect(parseNumber(42)).toBe(42);
  });
});

describe("filterRows", () => {
  const config = {
    HEADER_ROW: 3,
    TICKER_COL: CONFIG.TICKER_COL,
    TARGET_COL: CONFIG.TARGET_COL,
    PV_COL: CONFIG.PV_COL,
    WALLST_COL: CONFIG.WALLST_COL,
  };

  function sheetWithHeaderAtRow3(dataRows: string[][]): string[][] {
    return [
      ["Watch-List", "", "", ""],
      ["generated 2026-08-31", "", "", ""],
      ["Ticker", "Target", "PV $", "WallSt"],
      ...dataRows,
    ];
  }

  it("finds headers at HEADER_ROW (3) and filters Target > PV", () => {
    const rows = sheetWithHeaderAtRow3([
      ["AAA", "12", "10", "11"], // match: 12 > 10, WallSt > PV
      ["BBB", "15", "20", "21"], // no match: 15 <= 20
      ["CCC", "$9.50", "$5.00", "6"], // match, currency-formatted
    ]);

    const result = filterRows(rows, config);

    expect(result).toEqual([
      { ticker: "AAA", target: 12, pv: 10 },
      { ticker: "CCC", target: 9.5, pv: 5 },
    ]);
  });

  it("excludes a Target > PV match when WallSt is not greater than PV", () => {
    const rows = sheetWithHeaderAtRow3([
      ["AAA", "12", "10", "10.01"], // WallSt > PV -- kept
      ["BBB", "12", "10", "10"], // WallSt == PV -- dropped
      ["CCC", "12", "10", "9"], // WallSt < PV -- dropped
    ]);

    const result = filterRows(rows, config);

    expect(result).toEqual([{ ticker: "AAA", target: 12, pv: 10 }]);
  });

  it("keeps a Target > PV match when WallSt is unparseable", () => {
    const rows = sheetWithHeaderAtRow3([["AAA", "12", "10", "n/a"]]);

    const result = filterRows(rows, config);

    expect(result).toEqual([{ ticker: "AAA", target: 12, pv: 10 }]);
  });

  it("matches headers case-insensitively and trims whitespace", () => {
    const rows = [
      ["ignore", "", "", ""],
      ["ignore", "", "", ""],
      [" ticker ", " TARGET ", " pv $ ", " wallst "],
      ["AAA", "2", "1", "2"],
    ];

    const result = filterRows(rows, config);

    expect(result).toEqual([{ ticker: "AAA", target: 2, pv: 1 }]);
  });

  it("skips rows with unparseable numbers instead of throwing", () => {
    const rows = sheetWithHeaderAtRow3([
      ["AAA", "n/a", "12", "13"],
      ["BBB", "10", "", "1"],
      ["CCC", "2", "1", "2"],
    ]);

    const result = filterRows(rows, config);

    expect(result).toEqual([{ ticker: "CCC", target: 2, pv: 1 }]);
  });

  it("skips empty/short rows", () => {
    const rows = sheetWithHeaderAtRow3([[], ["AAA", "2", "1", "2"]]);

    const result = filterRows(rows, config);

    expect(result).toEqual([{ ticker: "AAA", target: 2, pv: 1 }]);
  });

  it("throws a descriptive error listing actual headers when a configured column is missing", () => {
    const rows = [
      ["ignore", "", "", ""],
      ["ignore", "", "", ""],
      ["Symbol", "Target Price", "Current", "WallSt"],
      ["AAA", "1", "2", "3"],
    ];

    expect(() => filterRows(rows, config)).toThrowError(
      /Configured column\(s\) not found\. Sheet headers were: \[Symbol, Target Price, Current, WallSt\]/
    );
  });

  it("throws a descriptive error when the sheet has fewer rows than HEADER_ROW", () => {
    const rows = [["only one row"]];

    expect(() => filterRows(rows, config)).toThrowError(/no row 3/);
  });

  it("supports rowsStartAtHeaderRow for ranges already trimmed to the header row", () => {
    const rows = [
      ["Ticker", "Target", "PV $", "WallSt"],
      ["AAA", "2", "1", "2"],
    ];

    const result = filterRows(rows, config, { rowsStartAtHeaderRow: true });

    expect(result).toEqual([{ ticker: "AAA", target: 2, pv: 1 }]);
  });
});
