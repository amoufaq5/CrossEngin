import { describe, expect, it } from "vitest";

import { CliUsageError } from "./cli.js";
import { DEFAULT_INCIDENT_ACTOR, incidentsHelpText, parseIncidentsArgs } from "./incidents-cli.js";

describe("parseIncidentsArgs", () => {
  it("defaults to help with no command", () => {
    expect(parseIncidentsArgs([]).help).toBe(true);
    expect(parseIncidentsArgs(["--help"]).help).toBe(true);
    expect(parseIncidentsArgs(["-h"]).help).toBe(true);
  });

  it("parses `open` with a limit + format (inline and spaced)", () => {
    const a = parseIncidentsArgs(["open", "--limit", "10", "--format", "json"]);
    expect(a).toMatchObject({ command: "open", limit: 10, format: "json" });
    const b = parseIncidentsArgs(["open", "--limit=5", "--format=human"]);
    expect(b).toMatchObject({ command: "open", limit: 5, format: "human" });
  });

  it("parses `period` with a window", () => {
    const a = parseIncidentsArgs(["period", "--from", "2026-06-01", "--to", "2026-06-30"]);
    expect(a).toMatchObject({ command: "period", from: "2026-06-01", to: "2026-06-30", format: "human" });
  });

  it("parses `verify` with a window + json format", () => {
    const a = parseIncidentsArgs(["verify", "--from=2026-06-01", "--to=2026-06-30", "--format=json"]);
    expect(a).toMatchObject({ command: "verify", from: "2026-06-01", to: "2026-06-30", format: "json" });
  });

  it("parses `metrics` with a window", () => {
    const a = parseIncidentsArgs(["metrics", "--from", "2026-06-01", "--to", "2026-06-30"]);
    expect(a).toMatchObject({ command: "metrics", from: "2026-06-01", to: "2026-06-30" });
  });

  it("requires --from and --to for period, verify, and metrics", () => {
    expect(() => parseIncidentsArgs(["period", "--from", "2026-06-01"])).toThrow(CliUsageError);
    expect(() => parseIncidentsArgs(["verify"])).toThrow(/requires --from and --to/);
    expect(() => parseIncidentsArgs(["metrics"])).toThrow(/requires --from and --to/);
  });

  it("rejects an unknown command, format, and argument", () => {
    expect(() => parseIncidentsArgs(["frobnicate"])).toThrow(/unknown incidents command/);
    expect(() => parseIncidentsArgs(["open", "--format", "xml"])).toThrow(/invalid --format/);
    expect(() => parseIncidentsArgs(["open", "--bogus"])).toThrow(/unknown argument/);
  });

  it("carries a custom schema", () => {
    expect(parseIncidentsArgs(["open", "--schema", "ops"]).schema).toBe("ops");
    expect(parseIncidentsArgs(["open", "--schema=ops"]).schema).toBe("ops");
  });

  it("parses ack/mitigate with a positional incident id + default actor", () => {
    const a = parseIncidentsArgs(["ack", "INC-2026-0001"]);
    expect(a).toMatchObject({ command: "ack", incidentId: "INC-2026-0001", actor: DEFAULT_INCIDENT_ACTOR });
    const m = parseIncidentsArgs(["mitigate", "INC-2026-0002", "--actor", "00000000-0000-4000-8000-000000000009"]);
    expect(m).toMatchObject({ command: "mitigate", incidentId: "INC-2026-0002", actor: "00000000-0000-4000-8000-000000000009" });
  });

  it("requires an incident id for ack/mitigate", () => {
    expect(() => parseIncidentsArgs(["ack"])).toThrow(/requires an incident id/);
    expect(() => parseIncidentsArgs(["mitigate", "--actor", "x"])).toThrow(/requires an incident id/);
  });

  it("rejects a missing value for a flag", () => {
    expect(() => parseIncidentsArgs(["open", "--limit"])).toThrow(/requires a value/);
  });

  it("rejects a non-integer --limit", () => {
    expect(() => parseIncidentsArgs(["open", "--limit", "abc"])).toThrow(/invalid --limit/);
    expect(() => parseIncidentsArgs(["open", "--limit", "0"])).toThrow(/invalid --limit/);
  });

  it("exposes operate-server-flavored help text", () => {
    expect(incidentsHelpText).toContain("operate-server incidents");
    expect(incidentsHelpText).toContain("MTTP/MTTA/MTTM/MTTR");
  });
});
