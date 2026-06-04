import { describe, expect, it } from "vitest";

import { CliUsageError, helpText, parseWorkerArgs } from "./cli.js";

describe("parseWorkerArgs", () => {
  it("defaults to mode=all with a random worker id and standard intervals", () => {
    const opts = parseWorkerArgs([]);
    expect(opts.mode).toBe("all");
    expect(opts.workerId).toMatch(/^worker-[a-z0-9]+$/);
    expect(opts).toMatchObject({
      schema: null,
      tickIntervalMs: 5000,
      claimIntervalMs: 1000,
      retryIntervalMs: 5000,
      batchSize: 50,
      leaseMs: 30000,
      definitionsPath: null,
      help: false,
      version: false,
    });
  });

  it("generates a distinct worker id per invocation", () => {
    expect(parseWorkerArgs([]).workerId).not.toBe(parseWorkerArgs([]).workerId);
  });

  it("parses every flag (space form)", () => {
    const opts = parseWorkerArgs([
      "--mode", "retry",
      "--worker-id", "w-7",
      "--schema", "wf",
      "--tick-interval-ms", "2000",
      "--claim-interval-ms", "500",
      "--retry-interval-ms", "8000",
      "--batch-size", "25",
      "--lease-ms", "45000",
      "--definitions", "/defs.json",
    ]);
    expect(opts).toEqual({
      mode: "retry",
      workerId: "w-7",
      schema: "wf",
      tickIntervalMs: 2000,
      claimIntervalMs: 500,
      retryIntervalMs: 8000,
      batchSize: 25,
      leaseMs: 45000,
      definitionsPath: "/defs.json",
      help: false,
      version: false,
    });
  });

  it("parses inline --flag=value form", () => {
    const opts = parseWorkerArgs(["--mode=claim", "--worker-id=w1", "--batch-size=10"]);
    expect(opts.mode).toBe("claim");
    expect(opts.workerId).toBe("w1");
    expect(opts.batchSize).toBe(10);
  });

  it("accepts all four modes", () => {
    for (const mode of ["tick", "claim", "retry", "all"] as const) {
      expect(parseWorkerArgs(["--mode", mode]).mode).toBe(mode);
    }
  });

  it("rejects an unknown mode", () => {
    expect(() => parseWorkerArgs(["--mode", "bogus"])).toThrow(CliUsageError);
  });

  it("rejects an unknown argument", () => {
    expect(() => parseWorkerArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("rejects a non-integer / below-minimum numeric flag", () => {
    expect(() => parseWorkerArgs(["--batch-size", "0"])).toThrow(CliUsageError);
    expect(() => parseWorkerArgs(["--tick-interval-ms", "abc"])).toThrow(CliUsageError);
    expect(() => parseWorkerArgs(["--lease-ms", "500"])).toThrow(CliUsageError);
  });

  it("rejects a flag with no value", () => {
    expect(() => parseWorkerArgs(["--worker-id"])).toThrow(/requires a value/);
  });

  it("recognizes help and version flags", () => {
    expect(parseWorkerArgs(["--help"]).help).toBe(true);
    expect(parseWorkerArgs(["-h"]).help).toBe(true);
    expect(parseWorkerArgs(["--version"]).version).toBe(true);
    expect(parseWorkerArgs(["-v"]).version).toBe(true);
  });
});

describe("helpText", () => {
  it("documents the mode flag and PG env requirement", () => {
    expect(helpText).toContain("--mode");
    expect(helpText).toContain("PGHOST");
    expect(helpText).toContain("BYPASSRLS");
  });
});
