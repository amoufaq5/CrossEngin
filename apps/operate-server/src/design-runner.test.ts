import { describe, expect, it } from "vitest";

import type { AiManifestCreateInput, DesignResultLike } from "./ai-design-routes.js";
import {
  DESIGN_JOB_MAX_ATTEMPTS,
  runDesignJob,
  startDesignJob,
  type AiManifestStoreLike,
  type DesignJobCreateInput,
  type DesignJobProgressInputLike,
  type DesignJobRecordLike,
  type DesignJobStoreLike,
  type DesignProgressLike,
  type DesignRunnerOptions,
  type ProgressingDesignerLike,
} from "./design-runner.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const JOB_ID = "adj_0001";
const OK_MANIFEST: Record<string, unknown> = { meta: { slug: "acme/crm" }, entities: [{ name: "Lead" }] };

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jobRecord(over: Partial<DesignJobRecordLike> = {}): DesignJobRecordLike {
  return {
    id: JOB_ID,
    tenantId: TENANT,
    status: "queued",
    phase: "queued",
    attempt: 0,
    maxAttempts: DESIGN_JOB_MAX_ATTEMPTS,
    name: "Plumber CRM",
    description: "A CRM for plumbers",
    outputChars: 0,
    issues: [],
    proposalId: null,
    providerLabel: null,
    error: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

class FakeJobStore implements DesignJobStoreLike {
  readonly calls: string[] = [];
  readonly updates: DesignJobProgressInputLike[] = [];
  readonly succeedCalls: Array<{ tenantId: string; id: string; proposalId: string; providerLabel: string | null }> =
    [];
  readonly failCalls: Array<{
    tenantId: string;
    id: string;
    error: string;
    issues?: readonly string[];
    providerLabel?: string | null;
  }> = [];
  updateDelayMs: (index: number) => number = () => 0;
  updateError: Error | null = null;
  terminalError: Error | null = null;
  terminalReturnsNull = false;
  private updateIndex = 0;

  async create(tenantId: string, input: DesignJobCreateInput): Promise<DesignJobRecordLike> {
    this.calls.push("create");
    return jobRecord({ tenantId, name: input.name, description: input.description, maxAttempts: input.maxAttempts });
  }

  async getById(tenantId: string, id: string): Promise<DesignJobRecordLike | null> {
    return jobRecord({ tenantId, id });
  }

  async updateProgress(
    tenantId: string,
    id: string,
    input: DesignJobProgressInputLike,
  ): Promise<DesignJobRecordLike | null> {
    const index = this.updateIndex;
    this.updateIndex += 1;
    await delay(this.updateDelayMs(index));
    if (this.updateError !== null) throw this.updateError;
    this.calls.push(`update:${input.phase ?? "none"}`);
    this.updates.push(input);
    return jobRecord({ tenantId, id, status: input.status ?? "running" });
  }

  async succeed(
    tenantId: string,
    id: string,
    input: { proposalId: string; providerLabel: string | null },
  ): Promise<DesignJobRecordLike | null> {
    this.calls.push("succeed");
    this.succeedCalls.push({ tenantId, id, ...input });
    if (this.terminalError !== null) throw this.terminalError;
    if (this.terminalReturnsNull) return null;
    return jobRecord({ tenantId, id, status: "succeeded", phase: "done", proposalId: input.proposalId });
  }

  async fail(
    tenantId: string,
    id: string,
    input: { error: string; issues?: readonly string[]; providerLabel?: string | null },
  ): Promise<DesignJobRecordLike | null> {
    this.calls.push("fail");
    this.failCalls.push({ tenantId, id, ...input });
    if (this.terminalError !== null) throw this.terminalError;
    if (this.terminalReturnsNull) return null;
    return jobRecord({ tenantId, id, status: "failed", phase: "error", error: input.error });
  }
}

class FakeManifestStore implements AiManifestStoreLike {
  readonly createCalls: Array<{ tenantId: string; input: AiManifestCreateInput }> = [];
  error: Error | null = null;

  async create(tenantId: string, input: AiManifestCreateInput): Promise<{ readonly id: string }> {
    this.createCalls.push({ tenantId, input });
    if (this.error !== null) throw this.error;
    return { id: "aim_0001" };
  }
}

function prog(
  phase: DesignProgressLike["phase"],
  attempt: number,
  outputChars = 0,
  issues: readonly string[] = [],
): DesignProgressLike {
  return { phase, attempt, maxAttempts: DESIGN_JOB_MAX_ATTEMPTS, outputChars, issues };
}

function okResult(over: Partial<DesignResultLike> = {}): DesignResultLike {
  return {
    ok: true,
    manifest: OK_MANIFEST,
    manifestHash: "sha256:abc123",
    issues: [],
    attempts: 1,
    providerLabel: "anthropic/claude-sonnet-4-6",
    usage: { inputTokens: 100, outputTokens: 400, cost: 0.0123 },
    ...over,
  };
}

function designerEmitting(
  progress: readonly DesignProgressLike[],
  result: DesignResultLike = okResult(),
): ProgressingDesignerLike {
  return async ({ onProgress }) => {
    for (const p of progress) onProgress?.(p);
    return result;
  };
}

interface Harness {
  readonly jobs: FakeJobStore;
  readonly manifests: FakeManifestStore;
  readonly errors: unknown[];
  readonly recorded: Array<{ tenantId: string; costUsd: number }>;
  readonly opts: DesignRunnerOptions;
}

function harness(designer: ProgressingDesignerLike, opts: { budget?: boolean; budgetError?: Error } = {}): Harness {
  const jobs = new FakeJobStore();
  const manifests = new FakeManifestStore();
  const errors: unknown[] = [];
  const recorded: Array<{ tenantId: string; costUsd: number }> = [];
  const budget =
    opts.budget === true
      ? {
          record: async (tenantId: string, costUsd: number): Promise<number> => {
            recorded.push({ tenantId, costUsd });
            if (opts.budgetError !== undefined) throw opts.budgetError;
            return costUsd;
          },
        }
      : undefined;
  return {
    jobs,
    manifests,
    errors,
    recorded,
    opts: {
      jobs,
      manifests,
      designer,
      budget,
      onError: (err: unknown) => errors.push(err),
    },
  };
}

const INPUT = { description: "A CRM for plumbers", name: "Plumber CRM" };

describe("design-runner — constants", () => {
  it("caps design retries at three attempts", () => {
    expect(DESIGN_JOB_MAX_ATTEMPTS).toBe(3);
  });
});

describe("design-runner — happy path", () => {
  it("marks the job running/generating, streams progress, then succeeds", async () => {
    const h = harness(designerEmitting([prog("generating", 1, 120), prog("validating", 1, 4200)]));
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.jobs.calls).toEqual(["update:generating", "update:generating", "update:validating", "succeed"]);
    expect(h.jobs.updates[0]).toEqual({ status: "running", phase: "generating" });
    expect(h.jobs.updates[2]).toEqual({
      status: "running",
      phase: "validating",
      attempt: 1,
      outputChars: 4200,
      issues: [],
    });
    expect(h.errors).toEqual([]);
  });

  it("creates the manifest proposal tenant-scoped with source ai, then records its id on the job", async () => {
    const h = harness(designerEmitting([]));
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.manifests.createCalls).toEqual([
      {
        tenantId: TENANT,
        input: {
          name: "Plumber CRM",
          description: "A CRM for plumbers",
          manifest: OK_MANIFEST,
          manifestHash: "sha256:abc123",
          source: "ai",
          providerLabel: "anthropic/claude-sonnet-4-6",
        },
      },
    ]);
    expect(h.jobs.succeedCalls).toEqual([
      { tenantId: TENANT, id: JOB_ID, proposalId: "aim_0001", providerLabel: "anthropic/claude-sonnet-4-6" },
    ]);
  });

  it("forwards retry progress with the attempt number and interim issues", async () => {
    const h = harness(designerEmitting([prog("retrying", 2, 900, ["entity Lead has no fields"])]));
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.jobs.updates[1]).toEqual({
      status: "running",
      phase: "retrying",
      attempt: 2,
      outputChars: 900,
      issues: ["entity Lead has no fields"],
    });
  });
});

describe("design-runner — failure paths", () => {
  it("fails the job with the issues and provider when the design does not validate", async () => {
    const h = harness(
      designerEmitting(
        [prog("retrying", 3, 10)],
        okResult({ ok: false, manifest: null, manifestHash: null, issues: ["invalid slug"], attempts: 3 }),
      ),
    );
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.manifests.createCalls).toHaveLength(0);
    expect(h.jobs.failCalls).toEqual([
      {
        tenantId: TENANT,
        id: JOB_ID,
        error: "design failed after 3 attempts",
        issues: ["invalid slug"],
        providerLabel: "anthropic/claude-sonnet-4-6",
      },
    ]);
  });

  it("fails an ok result whose manifest is missing", async () => {
    const h = harness(designerEmitting([], okResult({ manifest: null })));
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.jobs.failCalls).toHaveLength(1);
    expect(h.jobs.failCalls[0]?.error).toBe("design failed after 1 attempt");
  });

  it("never rejects when the designer throws: it fails the job and reports the error", async () => {
    const boom = new Error("provider timed out");
    const h = harness(async () => {
      throw boom;
    });
    await expect(runDesignJob(h.opts, TENANT, JOB_ID, INPUT)).resolves.toBeUndefined();
    expect(h.jobs.failCalls).toEqual([{ tenantId: TENANT, id: JOB_ID, error: "provider timed out" }]);
    expect(h.errors).toEqual([boom]);
  });

  it("never rejects when the manifest store throws", async () => {
    const h = harness(designerEmitting([]));
    h.manifests.error = new Error("proposal insert failed");
    await expect(runDesignJob(h.opts, TENANT, JOB_ID, INPUT)).resolves.toBeUndefined();
    expect(h.jobs.calls.at(-1)).toBe("fail");
    expect(h.jobs.failCalls[0]?.error).toBe("proposal insert failed");
  });

  it("never rejects when the terminal write itself throws", async () => {
    const h = harness(designerEmitting([]));
    h.jobs.terminalError = new Error("job row vanished");
    await expect(runDesignJob(h.opts, TENANT, JOB_ID, INPUT)).resolves.toBeUndefined();
    expect(h.errors).toHaveLength(1);
  });

  it("tolerates a terminal write whose job row is already gone", async () => {
    const h = harness(designerEmitting([]));
    h.jobs.terminalReturnsNull = true;
    await expect(runDesignJob(h.opts, TENANT, JOB_ID, INPUT)).resolves.toBeUndefined();
    expect(h.errors).toEqual([]);
  });
});

describe("design-runner — progress write ordering", () => {
  it("keeps the terminal succeed last even when progress writes are slow", async () => {
    const h = harness(designerEmitting([prog("generating", 1, 5), prog("validating", 1, 50)]));
    h.jobs.updateDelayMs = () => 15;
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.jobs.calls).toEqual(["update:generating", "update:generating", "update:validating", "succeed"]);
    expect(h.jobs.calls.at(-1)).toBe("succeed");
  });

  it("keeps the terminal fail last even when progress writes are slow", async () => {
    const h = harness(
      designerEmitting([prog("retrying", 2, 5)], okResult({ ok: false, manifest: null, manifestHash: null })),
    );
    h.jobs.updateDelayMs = () => 12;
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.jobs.calls.at(-1)).toBe("fail");
  });

  it("serializes progress writes in emission order despite unequal write latency", async () => {
    const h = harness(
      designerEmitting([prog("generating", 1, 1), prog("validating", 1, 2), prog("retrying", 2, 3)]),
    );
    // Descending delays: an unchained implementation would land these out of order.
    const delays = [30, 20, 10, 1];
    h.jobs.updateDelayMs = (index) => delays[index] ?? 0;
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.jobs.calls).toEqual([
      "update:generating",
      "update:generating",
      "update:validating",
      "update:retrying",
      "succeed",
    ]);
    expect(h.jobs.updates.map((u) => u.outputChars)).toEqual([undefined, 1, 2, 3]);
  });

  it("survives a failing progress write and still completes the job", async () => {
    const h = harness(designerEmitting([prog("generating", 1, 5)]));
    h.jobs.updateError = new Error("progress write failed");
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.jobs.calls).toEqual(["succeed"]);
    expect(h.errors).toHaveLength(2);
    expect(h.jobs.succeedCalls).toHaveLength(1);
  });
});

describe("design-runner — budget accounting", () => {
  it("charges the usage cost of a successful design", async () => {
    const h = harness(designerEmitting([]), { budget: true });
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.recorded).toEqual([{ tenantId: TENANT, costUsd: 0.0123 }]);
  });

  it("charges a failed design too — the tokens were still spent", async () => {
    const h = harness(
      designerEmitting(
        [],
        okResult({
          ok: false,
          manifest: null,
          manifestHash: null,
          issues: ["nope"],
          attempts: 3,
          usage: { inputTokens: 5, outputTokens: 5, cost: 0.02 },
        }),
      ),
      { budget: true },
    );
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.recorded).toEqual([{ tenantId: TENANT, costUsd: 0.02 }]);
    expect(h.jobs.failCalls).toHaveLength(1);
  });

  it("does not charge when usage is absent or zero", async () => {
    const none = harness(designerEmitting([], okResult({ usage: null })), { budget: true });
    await runDesignJob(none.opts, TENANT, JOB_ID, INPUT);
    const zero = harness(
      designerEmitting([], okResult({ usage: { inputTokens: 0, outputTokens: 0, cost: 0 } })),
      { budget: true },
    );
    await runDesignJob(zero.opts, TENANT, JOB_ID, INPUT);
    expect(none.recorded).toEqual([]);
    expect(zero.recorded).toEqual([]);
  });

  it("still succeeds when the ledger write throws", async () => {
    const h = harness(designerEmitting([]), { budget: true, budgetError: new Error("ledger down") });
    await runDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    expect(h.jobs.succeedCalls).toHaveLength(1);
    expect(h.errors).toHaveLength(1);
  });
});

describe("design-runner — startDesignJob", () => {
  it("returns void immediately and finishes the job later", async () => {
    const h = harness(async ({ onProgress }) => {
      onProgress?.(prog("generating", 1, 3));
      await delay(5);
      return okResult();
    });
    expect(startDesignJob(h.opts, TENANT, JOB_ID, INPUT)).toBeUndefined();
    expect(h.jobs.succeedCalls).toHaveLength(0);
    await delay(30);
    expect(h.jobs.succeedCalls).toHaveLength(1);
    expect(h.jobs.calls.at(-1)).toBe("succeed");
  });

  it("swallows a throwing designer without an unhandled rejection", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    startDesignJob(h.opts, TENANT, JOB_ID, INPUT);
    await delay(20);
    expect(h.jobs.failCalls).toHaveLength(1);
  });
});
