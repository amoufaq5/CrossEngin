import { describe, expect, it } from "vitest";

import { CliUsageError, parseServeArgs } from "./cli.js";

describe("parseServeArgs", () => {
  it("parses a pack + port + repeated api-keys", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-retail",
      "--port",
      "9000",
      "--api-key",
      "k1:cashier:t1",
      "--api-key",
      "k2:store_manager:t1",
    ]);
    expect(opts.pack).toBe("erp-retail");
    expect(opts.port).toBe(9000);
    expect(opts.apiKeys).toEqual(["k1:cashier:t1", "k2:store_manager:t1"]);
    expect(opts.store).toBe("memory");
  });

  it("supports --flag=value form", () => {
    const opts = parseServeArgs(["--pack=erp-core", "--port=8080", "--store=pg", "--schema=tenant_app"]);
    expect(opts.pack).toBe("erp-core");
    expect(opts.port).toBe(8080);
    expect(opts.store).toBe("pg");
    expect(opts.schema).toBe("tenant_app");
  });

  it("accepts the pg-columns store kind", () => {
    expect(parseServeArgs(["--pack", "erp-core", "--store", "pg-columns"]).store).toBe("pg-columns");
  });

  it("parses --manifest as the source", () => {
    const opts = parseServeArgs(["--manifest", "./m.json"]);
    expect(opts.manifestPath).toBe("./m.json");
    expect(opts.pack).toBeNull();
  });

  it("flags --help and --version without requiring a source", () => {
    expect(parseServeArgs(["--help"]).help).toBe(true);
    expect(parseServeArgs(["-v"]).version).toBe(true);
  });

  it("requires exactly one manifest source", () => {
    expect(() => parseServeArgs([])).toThrow(CliUsageError);
    expect(() => parseServeArgs(["--pack", "erp-core", "--manifest", "m.json"])).toThrow(/mutually exclusive/);
  });

  it("rejects invalid values", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--port", "70000"])).toThrow(/invalid --port/);
    expect(() => parseServeArgs(["--pack", "erp-core", "--store", "sqlite"])).toThrow(/invalid --store/);
    expect(() => parseServeArgs(["--pack", "erp-core", "--scheme", "ftp"])).toThrow(/invalid --scheme/);
    expect(() => parseServeArgs(["--bogus"])).toThrow(/unknown argument/);
  });

  it("requires a value for a value-flag", () => {
    expect(() => parseServeArgs(["--pack"])).toThrow(/requires a value/);
  });
});
