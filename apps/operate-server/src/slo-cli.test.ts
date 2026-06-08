import { describe, expect, it } from "vitest";

import { CliUsageError } from "./cli.js";
import { parseSloArgs, sloHelpText } from "./slo-cli.js";

describe("parseSloArgs", () => {
  it("parses `actions` with defaults", () => {
    const a = parseSloArgs(["actions"]);
    expect(a).toMatchObject({ command: "actions", since: null, limit: null, format: "human", help: false });
  });

  it("parses `summary` with --since + --limit (inline and spaced)", () => {
    const a = parseSloArgs(["summary", "--since", "2026-06-01T00:00:00Z", "--limit", "50"]);
    expect(a).toMatchObject({ command: "summary", since: "2026-06-01T00:00:00Z", limit: 50 });
    const b = parseSloArgs(["summary", "--since=2026-06-01T00:00:00Z", "--limit=5"]);
    expect(b).toMatchObject({ command: "summary", since: "2026-06-01T00:00:00Z", limit: 5 });
  });

  it("parses `verify` with a json format", () => {
    const a = parseSloArgs(["verify", "--format", "json"]);
    expect(a).toMatchObject({ command: "verify", format: "json" });
    const b = parseSloArgs(["verify", "--format=human"]);
    expect(b).toMatchObject({ command: "verify", format: "human" });
  });

  it("defaults to help with --help / -h and no command", () => {
    expect(parseSloArgs(["--help"]).help).toBe(true);
    expect(parseSloArgs(["-h"]).help).toBe(true);
  });

  it("carries help alongside a command", () => {
    expect(parseSloArgs(["verify", "--help"]).help).toBe(true);
  });

  it("rejects an unknown command", () => {
    expect(() => parseSloArgs(["frobnicate"])).toThrow(CliUsageError);
    expect(() => parseSloArgs(["frobnicate"])).toThrow(/unknown slo command/);
  });

  it("rejects an invalid format", () => {
    expect(() => parseSloArgs(["actions", "--format", "xml"])).toThrow(CliUsageError);
    expect(() => parseSloArgs(["actions", "--format=xml"])).toThrow(/--format must be human\|json/);
  });

  it("rejects a non-positive --limit", () => {
    expect(() => parseSloArgs(["actions", "--limit", "0"])).toThrow(CliUsageError);
    expect(() => parseSloArgs(["actions", "--limit", "-3"])).toThrow(/--limit must be a positive integer/);
  });

  it("rejects a missing value for a flag", () => {
    expect(() => parseSloArgs(["actions", "--since"])).toThrow(CliUsageError);
    expect(() => parseSloArgs(["actions", "--since"])).toThrow(/--since requires a value/);
  });

  it("re-wraps the package CliUsageError as the operate-server one", () => {
    try {
      parseSloArgs(["nope"]);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliUsageError);
    }
  });

  it("exposes operate-server-flavored help text", () => {
    expect(sloHelpText).toContain("operate-server slo");
    expect(sloHelpText).toContain("actions");
    expect(sloHelpText).toContain("--slo-persist");
  });
});
