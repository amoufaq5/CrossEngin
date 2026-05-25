import { describe, expect, it } from "vitest";
import {
  MODEL_FAMILIES,
  MODEL_LIFECYCLE_STATUSES,
  ModelCardSchema,
  ModelRegistryEntrySchema,
  ModelRegistrySchema,
  canTransitionModel,
  canaryAggregate,
  currentProductionModel,
  isModelServable,
  type ModelRegistryEntry,
} from "./models.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("MODEL_LIFECYCLE_STATUSES has 8 entries", () => {
    expect(MODEL_LIFECYCLE_STATUSES).toContain("draft");
    expect(MODEL_LIFECYCLE_STATUSES).toContain("canary");
    expect(MODEL_LIFECYCLE_STATUSES).toContain("production");
    expect(MODEL_LIFECYCLE_STATUSES).toContain("retired");
  });

  it("MODEL_FAMILIES has 8 entries", () => {
    expect(MODEL_FAMILIES).toContain("manifest_proposer");
    expect(MODEL_FAMILIES).toContain("safety_filter");
    expect(MODEL_FAMILIES).toContain("embeddings");
  });
});

describe("canTransitionModel", () => {
  it("draft -> evaluating", () => {
    expect(canTransitionModel("draft", "evaluating")).toBe(true);
  });

  it("approved -> canary", () => {
    expect(canTransitionModel("approved", "canary")).toBe(true);
  });

  it("canary -> production", () => {
    expect(canTransitionModel("canary", "production")).toBe(true);
  });

  it("production -> deprecated", () => {
    expect(canTransitionModel("production", "deprecated")).toBe(true);
  });

  it("retired is terminal", () => {
    expect(canTransitionModel("retired", "draft")).toBe(false);
  });

  it("draft -> production is not allowed", () => {
    expect(canTransitionModel("draft", "production")).toBe(false);
  });
});

describe("ModelCardSchema", () => {
  it("accepts a complete card", () => {
    expect(() =>
      ModelCardSchema.parse({
        intendedUse: "x",
        knownLimitations: ["limit 1"],
        trainingDataSummary: "x",
        evaluationSummary: "x",
        contactOwner: "team-ml",
      }),
    ).not.toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      ModelCardSchema.parse({
        intendedUse: "x",
        knownLimitations: ["x"],
        trainingDataSummary: "x",
        evaluationSummary: "x",
        contactOwner: "x",
        extra: "nope",
      }),
    ).toThrow();
  });
});

describe("ModelRegistryEntrySchema", () => {
  const base: ModelRegistryEntry = {
    id: "mdl_sql-001",
    family: "sql_codegen",
    label: "SQL Codegen v1",
    version: "1.0.0",
    baseModelId: "claude-haiku-4-5",
    trainingRunId: "train_abc12345",
    artifactSha256: SHA,
    artifactStorageUri: "s3://x/y",
    sizeBytes: 1_000_000,
    status: "production",
    card: {
      intendedUse: "SQL generation",
      knownLimitations: ["limited dialect support"],
      trainingDataSummary: "Public + internal queries",
      evaluationSummary: "95% pass rate on eval_sql-001",
      contactOwner: "team-ml",
    },
    blockingEvalRunIds: ["evalrun_abc12345"],
    canaryTrafficPercent: null,
    promotedToProductionAt: "2026-05-14T11:00:00Z",
    promotedToProductionBy: "u-1",
    deprecatedAt: null,
    retiredAt: null,
    createdAt: "2026-05-14T10:00:00Z",
    createdBy: "u-1",
  };

  it("accepts a valid production entry", () => {
    expect(() => ModelRegistryEntrySchema.parse(base)).not.toThrow();
  });

  it("rejects canary without canaryTrafficPercent", () => {
    expect(() =>
      ModelRegistryEntrySchema.parse({
        ...base,
        status: "canary",
        promotedToProductionAt: null,
        promotedToProductionBy: null,
      }),
    ).toThrow(/canaryTrafficPercent/);
  });

  it("rejects canary with 0% or 100% traffic", () => {
    expect(() =>
      ModelRegistryEntrySchema.parse({
        ...base,
        status: "canary",
        canaryTrafficPercent: 0,
        promotedToProductionAt: null,
        promotedToProductionBy: null,
      }),
    ).toThrow(/\(0, 100\)/);
  });

  it("rejects non-canary status with canaryTrafficPercent", () => {
    expect(() =>
      ModelRegistryEntrySchema.parse({
        ...base,
        canaryTrafficPercent: 50,
      }),
    ).toThrow(/canaryTrafficPercent=null/);
  });

  it("rejects production without promotedToProductionBy", () => {
    expect(() => ModelRegistryEntrySchema.parse({ ...base, promotedToProductionBy: null })).toThrow(
      /promotedToProductionBy/,
    );
  });

  it("rejects production without blocking eval runs", () => {
    expect(() => ModelRegistryEntrySchema.parse({ ...base, blockingEvalRunIds: [] })).toThrow(
      /at least one passing/,
    );
  });

  it("rejects safety_filter without fairnessConsiderations", () => {
    expect(() =>
      ModelRegistryEntrySchema.parse({
        ...base,
        family: "safety_filter",
      }),
    ).toThrow(/fairnessConsiderations/);
  });

  it("rejects duplicate blocking eval run ids", () => {
    expect(() =>
      ModelRegistryEntrySchema.parse({
        ...base,
        blockingEvalRunIds: ["evalrun_abc12345", "evalrun_abc12345"],
      }),
    ).toThrow(/duplicate eval run id/);
  });

  it("rejects model card with empty knownLimitations", () => {
    expect(() =>
      ModelRegistryEntrySchema.parse({
        ...base,
        card: { ...base.card, knownLimitations: [] },
      }),
    ).toThrow();
  });
});

describe("ModelRegistrySchema", () => {
  const entry = (
    id: string,
    family: ModelRegistryEntry["family"],
    status: ModelRegistryEntry["status"],
  ): ModelRegistryEntry => ({
    id,
    family,
    label: "x",
    version: "1.0.0",
    baseModelId: "base",
    trainingRunId: null,
    artifactSha256: SHA,
    artifactStorageUri: "s3://x/y",
    sizeBytes: 1,
    status,
    card: {
      intendedUse: "x",
      knownLimitations: ["x"],
      trainingDataSummary: "x",
      evaluationSummary: "x",
      contactOwner: "x",
    },
    blockingEvalRunIds: status === "production" ? ["evalrun_x"] : [],
    canaryTrafficPercent: status === "canary" ? 10 : null,
    promotedToProductionAt: status === "production" ? "2026-05-14T11:00:00Z" : null,
    promotedToProductionBy: status === "production" ? "u-1" : null,
    deprecatedAt: null,
    retiredAt: null,
    createdAt: "2026-05-14T10:00:00Z",
    createdBy: "u-1",
  });

  it("accepts a registry with one prod per family", () => {
    expect(() =>
      ModelRegistrySchema.parse([
        entry("mdl_alpha", "sql_codegen", "production"),
        entry("mdl_bravo", "manifest_proposer", "production"),
      ]),
    ).not.toThrow();
  });

  it("rejects duplicate model ids", () => {
    expect(() =>
      ModelRegistrySchema.parse([
        entry("mdl_alpha", "sql_codegen", "production"),
        entry("mdl_alpha", "manifest_proposer", "production"),
      ]),
    ).toThrow(/duplicate model id/);
  });

  it("rejects two production models in same family", () => {
    expect(() =>
      ModelRegistrySchema.parse([
        entry("mdl_alpha", "sql_codegen", "production"),
        { ...entry("mdl_bravo", "sql_codegen", "production"), version: "1.0.1" },
      ]),
    ).toThrow(/2.*production models.*only one is allowed/);
  });
});

describe("helpers", () => {
  const entry = (
    id: string,
    family: ModelRegistryEntry["family"],
    status: ModelRegistryEntry["status"],
    traffic: number | null = null,
  ): ModelRegistryEntry => ({
    id,
    family,
    label: "x",
    version: "1.0.0",
    baseModelId: "base",
    trainingRunId: null,
    artifactSha256: SHA,
    artifactStorageUri: "s3://x/y",
    sizeBytes: 1,
    status,
    card: {
      intendedUse: "x",
      knownLimitations: ["x"],
      trainingDataSummary: "x",
      evaluationSummary: "x",
      contactOwner: "x",
    },
    blockingEvalRunIds: status === "production" ? ["evalrun_x"] : [],
    canaryTrafficPercent: traffic,
    promotedToProductionAt: status === "production" ? "2026-05-14T11:00:00Z" : null,
    promotedToProductionBy: status === "production" ? "u-1" : null,
    deprecatedAt: null,
    retiredAt: null,
    createdAt: "2026-05-14T10:00:00Z",
    createdBy: "u-1",
  });

  const registry = [
    entry("mdl_prod", "sql_codegen", "production"),
    entry("mdl_canary", "sql_codegen", "canary", 10),
    entry("mdl_shadow", "sql_codegen", "shadow"),
  ];

  it("currentProductionModel returns the prod model", () => {
    expect(currentProductionModel(registry, "sql_codegen")?.id).toBe("mdl_prod");
  });

  it("currentProductionModel returns null when none", () => {
    expect(currentProductionModel(registry, "manifest_proposer")).toBeNull();
  });

  it("isModelServable returns true for production/canary/shadow", () => {
    expect(isModelServable(registry[0]!)).toBe(true);
    expect(isModelServable(registry[1]!)).toBe(true);
    expect(isModelServable(registry[2]!)).toBe(true);
  });

  it("isModelServable returns false for draft/retired", () => {
    expect(isModelServable(entry("mdl_draft", "sql_codegen", "draft"))).toBe(false);
  });

  it("canaryAggregate sums canary traffic", () => {
    expect(canaryAggregate(registry, "sql_codegen")).toBe(10);
  });
});
