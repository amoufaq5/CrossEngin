import { describe, expect, it } from "vitest";

import { CliUsageError, parseWebArgs } from "./cli.js";

describe("parseWebArgs", () => {
  it("parses --pack with defaults", () => {
    const opts = parseWebArgs(["--pack", "erp-retail"]);
    expect(opts.pack).toBe("erp-retail");
    expect(opts.port).toBe(8788);
    expect(opts.manifestPath).toBeNull();
  });

  it("supports inline --flag=value and repeated --api-key", () => {
    const opts = parseWebArgs(["--pack=erp-retail", "--port=9000", "--api-key", "a:r:t", "--api-key=b:r2:t"]);
    expect(opts.port).toBe(9000);
    expect(opts.apiKeys).toEqual(["a:r:t", "b:r2:t"]);
  });

  it("requires exactly one manifest source", () => {
    expect(() => parseWebArgs([])).toThrow(CliUsageError);
    expect(() => parseWebArgs(["--pack", "x", "--manifest", "f.json"])).toThrow(CliUsageError);
  });

  it("does not require a source for --help / --version", () => {
    expect(parseWebArgs(["--help"]).help).toBe(true);
    expect(parseWebArgs(["-v"]).version).toBe(true);
  });

  it("rejects an unknown flag + a bad port", () => {
    expect(() => parseWebArgs(["--pack", "x", "--what"])).toThrow(CliUsageError);
    expect(() => parseWebArgs(["--pack", "x", "--port", "70000"])).toThrow(CliUsageError);
  });
});
