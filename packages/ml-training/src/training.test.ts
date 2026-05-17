import { describe, expect, it } from "vitest";
import {
  HyperparametersSchema,
  TRAINING_KINDS,
  TRAINING_STATUSES,
  TrainingRunSchema,
  canTransitionTraining,
  costOverrunRatio,
  expectedLossImprovement,
  isTrainingTerminal,
  type Hyperparameters,
  type TrainingRun,
} from "./training.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("TRAINING_KINDS has 6 entries", () => {
    expect(TRAINING_KINDS).toContain("supervised_finetune");
    expect(TRAINING_KINDS).toContain("lora_adapter");
    expect(TRAINING_KINDS).toContain("full_pretrain_continue");
  });

  it("TRAINING_STATUSES has 6 entries", () => {
    expect(TRAINING_STATUSES).toEqual([
      "queued",
      "preparing",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ]);
  });
});

describe("canTransitionTraining", () => {
  it("queued -> preparing", () => {
    expect(canTransitionTraining("queued", "preparing")).toBe(true);
  });

  it("preparing -> running", () => {
    expect(canTransitionTraining("preparing", "running")).toBe(true);
  });

  it("running -> succeeded", () => {
    expect(canTransitionTraining("running", "succeeded")).toBe(true);
  });

  it("succeeded is terminal", () => {
    expect(canTransitionTraining("succeeded", "running")).toBe(false);
  });
});

describe("HyperparametersSchema", () => {
  const base: Hyperparameters = {
    learningRate: 0.0001,
    batchSize: 8,
    epochs: 3,
    warmupSteps: 100,
    weightDecay: 0.01,
    gradientAccumulationSteps: 4,
    seed: 42,
  };

  it("accepts a valid spec", () => {
    expect(() => HyperparametersSchema.parse(base)).not.toThrow();
  });

  it("rejects loraRank without loraAlpha", () => {
    expect(() =>
      HyperparametersSchema.parse({ ...base, loraRank: 16 }),
    ).toThrow(/loraAlpha/);
  });

  it("rejects loraAlpha without loraRank", () => {
    expect(() =>
      HyperparametersSchema.parse({ ...base, loraAlpha: 32 }),
    ).toThrow(/loraRank/);
  });

  it("rejects learningRate > 1", () => {
    expect(() =>
      HyperparametersSchema.parse({ ...base, learningRate: 1.5 }),
    ).toThrow();
  });
});

describe("TrainingRunSchema", () => {
  const base: TrainingRun = {
    id: "train_abc12345",
    label: "Manifest Proposer v1",
    kind: "lora_adapter",
    status: "succeeded",
    baseModelId: "claude-haiku-4-5",
    datasetId: "ds_global-001",
    datasetSha256: SHA,
    hyperparameters: {
      learningRate: 0.0001,
      batchSize: 8,
      epochs: 3,
      warmupSteps: 100,
      weightDecay: 0.01,
      gradientAccumulationSteps: 4,
      seed: 42,
      loraRank: 16,
      loraAlpha: 32,
    },
    estimatedCostUsd: 100,
    actualCostUsd: 95,
    estimatedDurationMinutes: 60,
    actualDurationMinutes: 58,
    queuedAt: "2026-05-14T10:00:00Z",
    startedAt: "2026-05-14T10:05:00Z",
    completedAt: "2026-05-14T11:03:00Z",
    requestedBy: "u-1",
    approvedBy: null,
    cancelledBy: null,
    outputModelArtifactSha256: SHA,
    outputModelStorageUri: "s3://x/y",
    trainLossFinal: 0.45,
    validationLossFinal: 0.5,
    tokensConsumed: 1_000_000,
  };

  it("accepts a valid succeeded run", () => {
    expect(() => TrainingRunSchema.parse(base)).not.toThrow();
  });

  it("rejects lora_adapter without loraRank in hyperparams", () => {
    expect(() =>
      TrainingRunSchema.parse({
        ...base,
        hyperparameters: { ...base.hyperparameters, loraRank: undefined, loraAlpha: undefined },
      }),
    ).toThrow(/loraRank/);
  });

  it("rejects full_pretrain_continue without approvedBy", () => {
    expect(() =>
      TrainingRunSchema.parse({
        ...base,
        kind: "full_pretrain_continue",
      }),
    ).toThrow(/approvedBy/);
  });

  it("rejects succeeded without outputModelArtifactSha256", () => {
    expect(() =>
      TrainingRunSchema.parse({ ...base, outputModelArtifactSha256: null }),
    ).toThrow(/outputModelArtifactSha256/);
  });

  it("rejects succeeded without actualCostUsd", () => {
    expect(() =>
      TrainingRunSchema.parse({ ...base, actualCostUsd: null }),
    ).toThrow(/actualCostUsd/);
  });

  it("rejects failed without failureReason", () => {
    expect(() =>
      TrainingRunSchema.parse({
        ...base,
        status: "failed",
        outputModelArtifactSha256: null,
        outputModelStorageUri: null,
        actualCostUsd: null,
      }),
    ).toThrow(/failureReason/);
  });

  it("rejects cancelled without cancelledBy + reason", () => {
    expect(() =>
      TrainingRunSchema.parse({
        ...base,
        status: "cancelled",
        outputModelArtifactSha256: null,
        outputModelStorageUri: null,
        actualCostUsd: null,
      }),
    ).toThrow(/cancelledBy/);
  });

  it("rejects actualCostUsd > 3x estimate", () => {
    expect(() =>
      TrainingRunSchema.parse({ ...base, actualCostUsd: 500 }),
    ).toThrow(/exceeds 3x estimate/);
  });
});

describe("helpers", () => {
  const run: TrainingRun = {
    id: "train_abc12345",
    label: "x",
    kind: "lora_adapter",
    status: "succeeded",
    baseModelId: "base",
    datasetId: "ds_x-001",
    datasetSha256: SHA,
    hyperparameters: {
      learningRate: 0.0001,
      batchSize: 8,
      epochs: 3,
      warmupSteps: 0,
      weightDecay: 0,
      gradientAccumulationSteps: 1,
      seed: 0,
      loraRank: 16,
      loraAlpha: 32,
    },
    estimatedCostUsd: 100,
    actualCostUsd: 120,
    estimatedDurationMinutes: 60,
    actualDurationMinutes: 58,
    queuedAt: "2026-05-14T10:00:00Z",
    startedAt: "2026-05-14T10:05:00Z",
    completedAt: "2026-05-14T11:03:00Z",
    requestedBy: "u-1",
    approvedBy: null,
    cancelledBy: null,
    outputModelArtifactSha256: SHA,
    outputModelStorageUri: "s3://x/y",
    trainLossFinal: 0.45,
    validationLossFinal: 0.5,
    tokensConsumed: 1_000_000,
  };

  it("isTrainingTerminal", () => {
    expect(isTrainingTerminal("succeeded")).toBe(true);
    expect(isTrainingTerminal("failed")).toBe(true);
    expect(isTrainingTerminal("cancelled")).toBe(true);
    expect(isTrainingTerminal("running")).toBe(false);
  });

  it("costOverrunRatio computes ratio", () => {
    expect(costOverrunRatio(run)).toBe(1.2);
  });

  it("costOverrunRatio returns null when actual unknown", () => {
    expect(costOverrunRatio({ ...run, actualCostUsd: null })).toBeNull();
  });

  it("expectedLossImprovement computes delta", () => {
    expect(expectedLossImprovement(run, 0.7)).toBeCloseTo(0.2);
  });

  it("expectedLossImprovement returns null when validation loss unknown", () => {
    expect(expectedLossImprovement({ ...run, validationLossFinal: null }, 0.7)).toBeNull();
  });
});
