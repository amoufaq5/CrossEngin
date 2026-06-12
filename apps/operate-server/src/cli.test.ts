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

  it("parses the SLO flags (defaults off)", () => {
    const off = parseServeArgs(["--pack", "erp-core"]);
    expect(off.slo).toBe(false);
    expect(off.sloPersist).toBe(false);
    expect(off.sloActor).toBeNull();
    expect(off.sloIntervalMs).toBeNull();
    expect(off.sloLatencyBudget).toBeNull();
    const on = parseServeArgs([
      "--pack", "erp-core", "--slo", "--slo-persist",
      "--slo-actor", "00000000-0000-4000-8000-000000000009", "--slo-interval-ms", "5000",
      "--slo-latency-budget", "500ms",
    ]);
    expect(on).toMatchObject({
      slo: true,
      sloPersist: true,
      sloActor: "00000000-0000-4000-8000-000000000009",
      sloIntervalMs: 5000,
      sloLatencyBudget: "500ms",
    });
    expect(() => parseServeArgs(["--pack", "erp-core", "--slo-interval-ms", "500"])).toThrow(CliUsageError);
  });

  it("parses --persist-executions (default off)", () => {
    expect(parseServeArgs(["--pack", "erp-core"]).persistExecutions).toBe(false);
    expect(parseServeArgs(["--pack", "erp-core", "--persist-executions"]).persistExecutions).toBe(true);
  });

  it("parses --marketplace (default off)", () => {
    expect(parseServeArgs(["--pack", "erp-core"]).marketplace).toBe(false);
    expect(parseServeArgs(["--pack", "erp-core", "--marketplace"]).marketplace).toBe(true);
  });

  it("parses --invalidation-channel (default off, requires --marketplace)", () => {
    expect(parseServeArgs(["--pack", "erp-core"]).invalidationChannel).toBe(false);
    expect(
      parseServeArgs(["--pack", "erp-core", "--marketplace", "--invalidation-channel"]).invalidationChannel,
    ).toBe(true);
    expect(() => parseServeArgs(["--pack", "erp-core", "--invalidation-channel"])).toThrow(/requires --marketplace/);
  });

  it("rejects an invalid --slo-latency-budget", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--slo-latency-budget", "fast"]),
    ).toThrow(CliUsageError);
  });

  it("accepts --slo-latency-budget in seconds", () => {
    const opts = parseServeArgs(["--pack", "erp-core", "--slo-latency-budget=5s"]);
    expect(opts.sloLatencyBudget).toBe("5s");
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

  it("parses JWKS + JWT flags", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--jwks-key",
      "key-1:AAAbase64",
      "--jwt-issuer",
      "https://idp/",
      "--jwt-audience",
      "https://api/",
    ]);
    expect(opts.jwksKeys).toEqual(["key-1:AAAbase64"]);
    expect(opts.jwtIssuer).toBe("https://idp/");
    expect(opts.jwtAudience).toBe("https://api/");
  });

  it("requires issuer + audience when a JWKS is configured", () => {
    expect(() => parseServeArgs(["--pack", "erp-core", "--jwks-key", "k:v"])).toThrow(/issuer.*audience/);
    expect(() => parseServeArgs(["--pack", "erp-core", "--jwks-url", "https://idp/jwks"])).toThrow(/issuer.*audience/);
  });

  it("parses a remote --jwks-url", () => {
    const opts = parseServeArgs([
      "--pack",
      "erp-core",
      "--jwks-url",
      "https://idp/.well-known/jwks.json",
      "--jwt-issuer",
      "https://idp/",
      "--jwt-audience",
      "https://api/",
    ]);
    expect(opts.jwksUrl).toBe("https://idp/.well-known/jwks.json");
  });
});
