import { describe, expect, it } from "vitest";
import {
  DATASET_STATUSES,
  DatasetSchema,
  REDACTION_STRATEGIES,
  canTransitionDataset,
  isDatasetUsableForTraining,
  splitRatio,
  splitSampleCount,
  type Dataset,
} from "./datasets.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("DATASET_STATUSES has 4 entries", () => {
    expect(DATASET_STATUSES).toEqual(["drafting", "frozen", "deprecated", "purged"]);
  });

  it("REDACTION_STRATEGIES has 4 entries", () => {
    expect(REDACTION_STRATEGIES).toContain("drop_row");
    expect(REDACTION_STRATEGIES).toContain("differential_privacy");
  });
});

describe("canTransitionDataset", () => {
  it("drafting -> frozen", () => {
    expect(canTransitionDataset("drafting", "frozen")).toBe(true);
  });

  it("frozen -> deprecated", () => {
    expect(canTransitionDataset("frozen", "deprecated")).toBe(true);
  });

  it("purged is terminal", () => {
    expect(canTransitionDataset("purged", "drafting")).toBe(false);
  });

  it("frozen -> drafting is not allowed", () => {
    expect(canTransitionDataset("frozen", "drafting")).toBe(false);
  });
});

describe("DatasetSchema", () => {
  const base: Dataset = {
    id: "ds_global-001",
    label: "Global Improvement v1",
    description: "Public + internal training data",
    purpose: "global_model_improvement",
    status: "frozen",
    sourceConsentIds: ["c-1"],
    dataClasses: ["public", "internal"],
    redactionStrategy: "drop_row",
    minimumKAnonymity: 5,
    splits: [
      { name: "train", sampleCount: 8000, sha256: SHA, sizeBytes: 1_000_000 },
      { name: "validation", sampleCount: 1000, sha256: SHA, sizeBytes: 100_000 },
      { name: "test", sampleCount: 1000, sha256: SHA, sizeBytes: 100_000 },
    ],
    totalSampleCount: 10_000,
    totalSizeBytes: 1_200_000,
    storageUri: "s3://crossengin-ml/datasets/ds_global-001",
    createdAt: "2026-05-14T10:00:00Z",
    createdBy: "u-1",
    frozenAt: "2026-05-14T11:00:00Z",
    frozenBy: "u-1",
    frozenSha256: SHA,
    deprecatedAt: null,
    purgedAt: null,
  };

  it("accepts a valid frozen dataset", () => {
    expect(() => DatasetSchema.parse(base)).not.toThrow();
  });

  it("rejects dataset without train split", () => {
    expect(() =>
      DatasetSchema.parse({
        ...base,
        splits: [
          { name: "validation", sampleCount: 10_000, sha256: SHA, sizeBytes: 1 },
        ],
        totalSampleCount: 10_000,
      }),
    ).toThrow(/must include a 'train' split/);
  });

  it("rejects sampleCount sum mismatch", () => {
    expect(() =>
      DatasetSchema.parse({
        ...base,
        totalSampleCount: 99_999,
      }),
    ).toThrow(/must equal sum/);
  });

  it("rejects dataClasses with phi", () => {
    expect(() =>
      DatasetSchema.parse({
        ...base,
        dataClasses: ["phi"],
      }),
    ).toThrow(/'phi' or 'regulated'/);
  });

  it("rejects duplicate split names", () => {
    expect(() =>
      DatasetSchema.parse({
        ...base,
        splits: [
          { name: "train", sampleCount: 5_000, sha256: SHA, sizeBytes: 1 },
          { name: "train", sampleCount: 5_000, sha256: SHA, sizeBytes: 1 },
        ],
      }),
    ).toThrow(/duplicate split 'train'/);
  });

  it("rejects frozen without frozenSha256", () => {
    expect(() =>
      DatasetSchema.parse({ ...base, frozenSha256: null }),
    ).toThrow(/frozenSha256/);
  });

  it("rejects PII + differential_privacy with low k-anonymity", () => {
    expect(() =>
      DatasetSchema.parse({
        ...base,
        dataClasses: ["public", "pii"],
        redactionStrategy: "differential_privacy",
        minimumKAnonymity: 5,
      }),
    ).toThrow(/minimumKAnonymity >= 10/);
  });

  it("rejects deprecated without reason", () => {
    expect(() =>
      DatasetSchema.parse({
        ...base,
        status: "deprecated",
        deprecatedAt: "2026-06-01T00:00:00Z",
      }),
    ).toThrow(/deprecatedReason/);
  });

  it("rejects purged without reason", () => {
    expect(() =>
      DatasetSchema.parse({
        ...base,
        status: "purged",
        purgedAt: "2026-06-01T00:00:00Z",
      }),
    ).toThrow(/purgedReason/);
  });

  it("rejects duplicate consent ids", () => {
    expect(() =>
      DatasetSchema.parse({
        ...base,
        sourceConsentIds: ["c-1", "c-1"],
      }),
    ).toThrow(/duplicate consent id/);
  });
});

describe("helpers", () => {
  const ds: Dataset = {
    id: "ds_test-001",
    label: "x",
    description: "x",
    purpose: "benchmarking_only",
    status: "frozen",
    sourceConsentIds: ["c-1"],
    dataClasses: ["public"],
    redactionStrategy: "drop_row",
    minimumKAnonymity: 5,
    splits: [
      { name: "train", sampleCount: 800, sha256: SHA, sizeBytes: 1 },
      { name: "test", sampleCount: 200, sha256: SHA, sizeBytes: 1 },
    ],
    totalSampleCount: 1000,
    totalSizeBytes: 2,
    storageUri: "s3://x/y",
    createdAt: "2026-05-14T10:00:00Z",
    createdBy: "u-1",
    frozenAt: "2026-05-14T11:00:00Z",
    frozenBy: "u-1",
    frozenSha256: SHA,
    deprecatedAt: null,
    purgedAt: null,
  };

  it("splitSampleCount returns the named split", () => {
    expect(splitSampleCount(ds, "train")).toBe(800);
    expect(splitSampleCount(ds, "test")).toBe(200);
    expect(splitSampleCount(ds, "validation")).toBe(0);
  });

  it("splitRatio computes proportional sizes", () => {
    expect(splitRatio(ds, "train")).toBe(0.8);
    expect(splitRatio(ds, "test")).toBe(0.2);
  });

  it("isDatasetUsableForTraining requires frozen + sha", () => {
    expect(isDatasetUsableForTraining(ds)).toBe(true);
    expect(
      isDatasetUsableForTraining({ ...ds, status: "drafting", frozenSha256: null }),
    ).toBe(false);
  });
});
