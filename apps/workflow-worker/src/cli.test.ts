import { describe, expect, it } from "vitest";

import { CliUsageError, DEFAULT_PAGE_WEBHOOK_MAX_ATTEMPTS, helpText, parseWebhookHeaderSpec, parseWorkerArgs } from "./cli.js";

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
      timeoutIntervalMs: 10000,
      executeIntervalMs: 2000,
      reapIntervalMs: 30000,
      resyncIntervalMs: 300000,
      resyncMax: 500,
      batchSize: 50,
      leaseMs: 30000,
      heartbeatIntervalMs: 15000,
      heartbeatEnabled: true,
      monitorEnabled: false,
      monitorIntervalMs: 30000,
      staleAfterMs: 60000,
      monitorDeclaredBy: "00000000-0000-4000-8000-000000000000",
      persistIncidents: false,
      pageWebhookHeaders: {},
      pageWebhookMaxAttempts: DEFAULT_PAGE_WEBHOOK_MAX_ATTEMPTS,
      definitionsPath: null,
      help: false,
      version: false,
    });
  });

  it("enables the stale-worker monitor with --monitor and its tuning flags", () => {
    const opts = parseWorkerArgs(["--monitor", "--monitor-interval-ms", "5000", "--stale-after-ms", "90000", "--monitor-declared-by", "00000000-0000-4000-8000-0000000000ff"]);
    expect(opts.monitorEnabled).toBe(true);
    expect(opts.monitorIntervalMs).toBe(5000);
    expect(opts.staleAfterMs).toBe(90000);
    expect(opts.monitorDeclaredBy).toBe("00000000-0000-4000-8000-0000000000ff");
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
      "--timeout-interval-ms", "12000",
      "--execute-interval-ms", "3000",
      "--reap-interval-ms", "20000",
      "--resync-interval-ms", "120000",
      "--resync-max", "250",
      "--batch-size", "25",
      "--lease-ms", "45000",
      "--heartbeat-interval-ms", "30000",
      "--definitions", "/defs.json",
    ]);
    expect(opts).toEqual({
      mode: "retry",
      workerId: "w-7",
      schema: "wf",
      tickIntervalMs: 2000,
      claimIntervalMs: 500,
      retryIntervalMs: 8000,
      timeoutIntervalMs: 12000,
      executeIntervalMs: 3000,
      reapIntervalMs: 20000,
      resyncIntervalMs: 120000,
      resyncMax: 250,
      batchSize: 25,
      leaseMs: 45000,
      heartbeatIntervalMs: 30000,
      heartbeatEnabled: true,
      monitorEnabled: false,
      monitorIntervalMs: 30000,
      staleAfterMs: 60000,
      monitorDeclaredBy: "00000000-0000-4000-8000-000000000000",
      persistIncidents: false,
      pageWebhookUrl: null,
      pageWebhookHeaders: {},
      pageWebhookMaxAttempts: DEFAULT_PAGE_WEBHOOK_MAX_ATTEMPTS,
      definitionsPath: "/defs.json",
      help: false,
      version: false,
    });
  });

  it("--page-webhook-header is repeatable and parses values containing ':'", () => {
    const opts = parseWorkerArgs([
      "--page-webhook-header", "authorization:Bearer abc:def",
      "--page-webhook-header", "PagerDuty-Token:xyz",
      "--page-webhook-header=Slack-Signature:v0=hex",
    ]);
    expect(opts.pageWebhookHeaders).toEqual({
      authorization: "Bearer abc:def",
      "PagerDuty-Token": "xyz",
      "Slack-Signature": "v0=hex",
    });
  });

  it("--page-webhook-max-attempts sets the retry budget (min 1)", () => {
    expect(parseWorkerArgs(["--page-webhook-max-attempts", "7"]).pageWebhookMaxAttempts).toBe(7);
    expect(parseWorkerArgs(["--page-webhook-max-attempts=1"]).pageWebhookMaxAttempts).toBe(1);
    expect(() => parseWorkerArgs(["--page-webhook-max-attempts", "0"])).toThrow(CliUsageError);
    expect(() => parseWorkerArgs(["--page-webhook-max-attempts", "abc"])).toThrow(CliUsageError);
  });

  it("rejects a malformed --page-webhook-header", () => {
    expect(() => parseWorkerArgs(["--page-webhook-header", "noColonHere"])).toThrow(CliUsageError);
    expect(() => parseWorkerArgs(["--page-webhook-header", ":empty-key"])).toThrow(CliUsageError);
  });

  it("--persist-incidents enables the meta.incidents sink", () => {
    expect(parseWorkerArgs(["--monitor", "--persist-incidents"]).persistIncidents).toBe(true);
    expect(parseWorkerArgs([]).persistIncidents).toBe(false);
    expect(parseWorkerArgs(["--page-webhook-url", "https://hooks.example/x"]).pageWebhookUrl).toBe("https://hooks.example/x");
    expect(parseWorkerArgs(["--page-webhook-url=https://h/y"]).pageWebhookUrl).toBe("https://h/y");
    expect(parseWorkerArgs([]).pageWebhookUrl).toBeNull();
  });

  it("--no-heartbeat disables the heartbeat", () => {
    expect(parseWorkerArgs(["--no-heartbeat"]).heartbeatEnabled).toBe(false);
  });

  it("parses inline --flag=value form", () => {
    const opts = parseWorkerArgs(["--mode=claim", "--worker-id=w1", "--batch-size=10"]);
    expect(opts.mode).toBe("claim");
    expect(opts.workerId).toBe("w1");
    expect(opts.batchSize).toBe(10);
  });

  it("accepts all eight modes", () => {
    for (const mode of ["tick", "claim", "retry", "timeout", "execute", "reap", "resync", "all"] as const) {
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

  it("documents the new page-webhook auth and retry flags", () => {
    expect(helpText).toContain("--page-webhook-header");
    expect(helpText).toContain("--page-webhook-max-attempts");
  });
});

describe("parseWebhookHeaderSpec", () => {
  it("splits at the first colon and trims both sides", () => {
    expect(parseWebhookHeaderSpec("Authorization: Bearer xyz")).toEqual({ key: "Authorization", value: "Bearer xyz" });
  });

  it("preserves colons in the value", () => {
    expect(parseWebhookHeaderSpec("x:a:b:c")).toEqual({ key: "x", value: "a:b:c" });
  });

  it("rejects an empty key or missing colon", () => {
    expect(() => parseWebhookHeaderSpec(":v")).toThrow(CliUsageError);
    expect(() => parseWebhookHeaderSpec("nope")).toThrow(CliUsageError);
  });
});
