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
  };

  function sheetWithHeaderAtRow3(dataRows: string[][]): string[][] {
    return [
      ["Watch-List", "", ""],
      ["generated 2026-08-31", "", ""],
      ["Ticker", "Target", "PV $"],
      ...dataRows,
    ];
  }

  it("finds headers at HEADER_ROW (3) and filters Target < PV", () => {
    const rows = sheetWithHeaderAtRow3([
      ["AAA", "10", "12"], // match: 10 < 12
      ["BBB", "20", "15"], // no match: 20 >= 15
      ["CCC", "$5.00", "$9.50"], // match, currency-formatted
    ]);

    const result = filterRows(rows, config);

    expect(result).toEqual([
      { ticker: "AAA", target: 10, pv: 12 },
      { ticker: "CCC", target: 5, pv: 9.5 },
    ]);
  });

  it("matches headers case-insensitively and trims whitespace", () => {
    const rows = [
      ["ignore", "", ""],
      ["ignore", "", ""],
      [" ticker ", " TARGET ", " pv $ "],
      ["AAA", "1", "2"],
    ];

    const result = filterRows(rows, config);

    expect(result).toEqual([{ ticker: "AAA", target: 1, pv: 2 }]);
  });

  it("skips rows with unparseable numbers instead of throwing", () => {
    const rows = sheetWithHeaderAtRow3([
      ["AAA", "n/a", "12"],
      ["BBB", "10", ""],
      ["CCC", "1", "2"],
    ]);

    const result = filterRows(rows, config);

    expect(result).toEqual([{ ticker: "CCC", target: 1, pv: 2 }]);
  });

  it("skips empty/short rows", () => {
    const rows = sheetWithHeaderAtRow3([[], ["AAA", "1", "2"]]);

    const result = filterRows(rows, config);

    expect(result).toEqual([{ ticker: "AAA", target: 1, pv: 2 }]);
  });

  it("throws a descriptive error listing actual headers when a configured column is missing", () => {
    const rows = [
      ["ignore", "", ""],
      ["ignore", "", ""],
      ["Symbol", "Target Price", "Current"],
      ["AAA", "1", "2"],
    ];

    expect(() => filterRows(rows, config)).toThrowError(
      /Configured column\(s\) not found\. Sheet headers were: \[Symbol, Target Price, Current\]/
    );
  });

  it("throws a descriptive error when the sheet has fewer rows than HEADER_ROW", () => {
    const rows = [["only one row"]];

    expect(() => filterRows(rows, config)).toThrowError(/no row 3/);
  });

  it("supports rowsStartAtHeaderRow for ranges already trimmed to the header row", () => {
    const rows = [
      ["Ticker", "Target", "PV $"],
      ["AAA", "1", "2"],
    ];

    const result = filterRows(rows, config, { rowsStartAtHeaderRow: true });

    expect(result).toEqual([{ ticker: "AAA", target: 1, pv: 2 }]);
  });
});
