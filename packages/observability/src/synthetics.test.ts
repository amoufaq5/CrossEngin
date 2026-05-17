import { describe, expect, it } from "vitest";
import {
  ComponentStatusSchema,
  COMPONENT_STATUSES,
  StatusIncidentSchema,
  StatusPageComponentSchema,
  STATUS_PAGE_COMPONENTS,
  SyntheticCheckDeclarationSchema,
  SYNTHETIC_CHECK_KINDS,
} from "./synthetics.js";

const now = "2026-05-13T10:00:00.000Z";

describe("SyntheticCheckDeclarationSchema", () => {
  it("parses an http check with defaults", () => {
    const c = SyntheticCheckDeclarationSchema.parse({
      id: "api-health",
      name: "API Health",
      schedule: "*/5 * * * *",
      region: "eu-central-1",
      check: { kind: "http", url: "https://api.example.com/health" },
    });
    expect(c.alertAfterConsecutiveFailures).toBe(2);
    if (c.check.kind === "http") {
      expect(c.check.method).toBe("GET");
      expect(c.check.expectStatus).toEqual([200]);
      expect(c.check.timeoutMs).toBe(5000);
    }
  });

  it("parses an AI architect synthetic", () => {
    const c = SyntheticCheckDeclarationSchema.parse({
      id: "ai-architect-smoke",
      name: "AI Architect Smoke",
      schedule: "*/15 * * * *",
      region: "us-east-1",
      check: {
        kind: "ai_architect_conversation",
        tenantId: "t_test",
        scenarioId: "plan-tool-reply-1",
        maxLatencyMs: 20_000,
        expectedToolCalls: ["searchManifest", "applyManifestPatch"],
      },
    });
    expect(c.check.kind).toBe("ai_architect_conversation");
  });

  it("rejects an unknown check kind", () => {
    expect(() =>
      SyntheticCheckDeclarationSchema.parse({
        id: "x",
        name: "x",
        schedule: "0 6 * * *",
        region: "eu",
        check: { kind: "thinking_check" },
      }),
    ).toThrow();
  });

  it("rejects a non-cron schedule", () => {
    expect(() =>
      SyntheticCheckDeclarationSchema.parse({
        id: "x",
        name: "x",
        schedule: "every five minutes",
        region: "eu",
        check: { kind: "http", url: "https://x" },
      }),
    ).toThrow();
  });

  it("SYNTHETIC_CHECK_KINDS has five kinds", () => {
    expect(SYNTHETIC_CHECK_KINDS).toHaveLength(5);
  });
});

describe("StatusPageComponentSchema", () => {
  it("parses a component", () => {
    const c = StatusPageComponentSchema.parse({
      id: "api",
      label: "Kernel API",
      region: "eu-central-1",
      status: "operational",
      updatedAt: now,
    });
    expect(c.status).toBe("operational");
  });

  it("rejects a non-canonical component id", () => {
    expect(() =>
      StatusPageComponentSchema.parse({
        id: "secret_api",
        label: "Secret API",
        region: "eu",
        status: "operational",
        updatedAt: now,
      }),
    ).toThrow();
  });

  it("STATUS_PAGE_COMPONENTS lists eight components", () => {
    expect(STATUS_PAGE_COMPONENTS).toHaveLength(8);
  });

  it("ComponentStatusSchema accepts all documented values", () => {
    for (const s of COMPONENT_STATUSES) {
      expect(() => ComponentStatusSchema.parse(s)).not.toThrow();
    }
  });
});

describe("StatusIncidentSchema", () => {
  it("parses an open incident", () => {
    const i = StatusIncidentSchema.parse({
      id: "i_1",
      title: "Elevated p95 latency on integrations",
      startedAt: now,
      impact: "minor",
      affectedComponents: ["integrations"],
      regions: ["eu-central-1"],
    });
    expect(i.resolvedAt).toBeUndefined();
  });

  it("parses a resolved incident with a post-mortem URL", () => {
    const i = StatusIncidentSchema.parse({
      id: "i_2",
      title: "Auth outage",
      startedAt: now,
      resolvedAt: now,
      impact: "critical",
      affectedComponents: ["auth"],
      regions: ["us-east-1"],
      postMortemUrl: "https://docs.example/incidents/i_2",
    });
    expect(i.impact).toBe("critical");
  });

  it("requires at least one affected component + region", () => {
    expect(() =>
      StatusIncidentSchema.parse({
        id: "x",
        title: "x",
        startedAt: now,
        impact: "minor",
        affectedComponents: [],
        regions: ["eu"],
      }),
    ).toThrow();
  });
});
