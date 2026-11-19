import { describe, expect, it } from "vitest";

import { JOB_QUEUE_VISIBILITY } from "./job-claim.js";
import { WORKFLOW_ENGINE_UNREACHABLE_REASONS, formatWorkflowEngineReach } from "./engine-reach.js";

describe("formatWorkflowEngineReach", () => {
  it("says what mounted the engine and that nothing creates an instance", () => {
    const lines = formatWorkflowEngineReach({ cancellationRoute: true, workers: true, eventsVisibility: "visible" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.line).toContain("the cancellation route and the worker fleet");
    expect(lines[0]!.line).toContain("no route publishes a definition, starts an instance or submits a signal");
  });

  it("warns when the engine's own reads cannot see the log as this connection", () => {
    const lines = formatWorkflowEngineReach({ cancellationRoute: true, workers: false, eventsVisibility: "confined_by_rls" });
    expect(lines.map((l) => l.level)).toEqual(["info", "warn"]);
    expect(lines[1]!.line).toContain("every instance read answers not found");
  });

  it("answers for every visibility, warning on all but visible", () => {
    for (const v of JOB_QUEUE_VISIBILITY) {
      const lines = formatWorkflowEngineReach({ cancellationRoute: false, workers: true, eventsVisibility: v });
      expect(lines.length).toBe(v === "visible" ? 1 : 2);
    }
  });

  it("asserts nothing about visibility it was not asked", () => {
    expect(formatWorkflowEngineReach({ cancellationRoute: true, workers: false, eventsVisibility: null })).toHaveLength(1);
  });

  it("states two reasons, each a fact about the binary rather than a missing feature flag", () => {
    expect(WORKFLOW_ENGINE_UNREACHABLE_REASONS).toEqual(["definitions_load_at_boot", "engine_reads_are_unscoped"]);
  });
});
