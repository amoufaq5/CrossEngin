import { JobDeclarationSchema, type JobDeclaration } from "@crossengin/jobs";
import { describe, expect, it } from "vitest";

import {
  JOB_HANDLER_BUILD_REFUSALS,
  JobHandlerBuildError,
  buildJobHandlerRegistry,
  type JobHandlerProvider,
} from "./job-handlers.js";
import type { JobHandler } from "./job-engine.js";

const handler: JobHandler = async () => ({ status: "completed" });
const other: JobHandler = async () => ({ status: "failed", error: { code: "x" } });

function job(
  id: string,
  trigger: JobDeclaration["trigger"],
  overrides: Record<string, unknown> = {},
): JobDeclaration {
  return JobDeclarationSchema.parse({
    id,
    name: id,
    trigger,
    onFailure: { strategy: "dead-letter" },
    ...overrides,
  });
}

const CRON: JobDeclaration["trigger"] = { kind: "scheduled", cron: "0 6 * * *" };
const EVENT: JobDeclaration["trigger"] = { kind: "event", eventName: "billing.payment_received" };

const sweep = job("sweep-invoices", CRON, {
  retry: {
    maxAttempts: 3,
    backoff: { kind: "exponential", initialDelay: "PT1M", maxDelay: "PT30M", jitter: true },
  },
});
const reorder = job("reorder-stock", CRON, { retry: { maxAttempts: 7 } });
const onPayment = job("on-payment", EVENT);

describe("JOB_HANDLER_BUILD_REFUSALS", () => {
  it("has no duplicates", () => {
    expect(new Set(JOB_HANDLER_BUILD_REFUSALS).size).toBe(JOB_HANDLER_BUILD_REFUSALS.length);
  });

  it("every refusal is reachable", () => {
    const reached = new Set<string>();
    const attempts: readonly { jobs: readonly JobDeclaration[]; providers: readonly JobHandlerProvider[] }[] = [
      { jobs: [sweep], providers: [{ serves: "job", jobId: "nope", handler }] },
      {
        jobs: [sweep],
        providers: [
          { serves: "job", jobId: "sweep-invoices", handler },
          { serves: "job", jobId: "sweep-invoices", handler: other },
        ],
      },
      { jobs: [sweep], providers: [{ serves: "kind", jobKind: "cdc", handler }] },
      {
        jobs: [sweep],
        providers: [
          { serves: "job", jobId: "sweep-invoices", handler, retry: { maxAttempts: 2 } } as unknown as JobHandlerProvider,
        ],
      },
    ];
    for (const attempt of attempts) {
      try {
        buildJobHandlerRegistry(attempt);
      } catch (err) {
        if (err instanceof JobHandlerBuildError) reached.add(err.code);
      }
    }
    expect([...reached].sort()).toEqual([...JOB_HANDLER_BUILD_REFUSALS].sort());
  });
});

describe("buildJobHandlerRegistry", () => {
  it("registers a job provider and resolves it by job id", () => {
    const build = buildJobHandlerRegistry({
      jobs: [sweep, onPayment],
      providers: [{ serves: "job", jobId: "sweep-invoices", handler }],
    });
    expect(build.registry.resolve("sweep-invoices", "scheduled")?.handler).toBe(handler);
    expect(build.servedJobIds).toEqual(["sweep-invoices"]);
  });

  it("takes the attempt ceiling from the declaration, never from the provider", () => {
    const build = buildJobHandlerRegistry({
      jobs: [reorder],
      providers: [{ serves: "job", jobId: "reorder-stock", handler }],
    });
    const registration = build.registry.resolve("reorder-stock", "scheduled");
    expect(registration?.retry?.maxAttempts).toBe(7);
    expect(registration?.maxAttempts).toBeUndefined();
  });

  it("sets maxAttempts 1 for a declaration with no retry policy, rather than leaving it implicit", () => {
    const build = buildJobHandlerRegistry({
      jobs: [onPayment],
      providers: [{ serves: "job", jobId: "on-payment", handler }],
    });
    const registration = build.registry.resolve("on-payment", "event");
    expect(registration?.maxAttempts).toBe(1);
    expect(registration?.retry).toBeUndefined();
  });

  it("carries the declaration's onFailure onto the registration", () => {
    const swallowing = job("quiet", CRON, { onFailure: { strategy: "swallow-and-log" }, idempotent: true });
    const build = buildJobHandlerRegistry({
      jobs: [swallowing],
      providers: [{ serves: "job", jobId: "quiet", handler }],
    });
    expect(build.registry.resolve("quiet", "scheduled")?.onFailure?.strategy).toBe("swallow-and-log");
  });

  it("attaches a jitter sampler only when the declared backoff asks for jitter", () => {
    const rng = (): number => 0.5;
    const build = buildJobHandlerRegistry({
      jobs: [sweep, reorder],
      providers: [{ serves: "kind", jobKind: "scheduled", handler }],
      jitterRng: rng,
    });
    // `sweep` declares `jitter: true`; `reorder` has a policy with no backoff at all.
    expect(build.registry.resolve("sweep-invoices", "scheduled")?.jitterRng).toBe(rng);
    expect(build.registry.resolve("reorder-stock", "scheduled")?.jitterRng).toBeUndefined();
  });

  it("expands a kind provider into one registration per matching declaration", () => {
    const build = buildJobHandlerRegistry({
      jobs: [sweep, reorder, onPayment],
      providers: [{ serves: "kind", jobKind: "scheduled", handler }],
    });
    expect(build.servedJobIds).toEqual(["sweep-invoices", "reorder-stock"]);
    // Each registration keeps its own declaration's ceiling — the reason the expansion exists.
    expect(build.registry.resolve("sweep-invoices", "scheduled")?.retry?.maxAttempts).toBe(3);
    expect(build.registry.resolve("reorder-stock", "scheduled")?.retry?.maxAttempts).toBe(7);
    expect(build.registry.resolve("on-payment", "event")).toBeUndefined();
  });

  it("leaves the registry's kind map empty, so an undeclared job id resolves to nothing", () => {
    const build = buildJobHandlerRegistry({
      jobs: [sweep],
      providers: [{ serves: "kind", jobKind: "scheduled", handler }],
    });
    // A stale row for a removed declaration must not be served by a catch-all: nothing is known
    // about its retry policy or data classes.
    expect(build.registry.resolve("a-job-that-was-deleted", "scheduled")).toBeUndefined();
  });

  it("lets a job provider win over a kind provider covering the same job", () => {
    const build = buildJobHandlerRegistry({
      jobs: [sweep, reorder],
      providers: [
        { serves: "kind", jobKind: "scheduled", handler },
        { serves: "job", jobId: "sweep-invoices", handler: other },
      ],
    });
    expect(build.registry.resolve("sweep-invoices", "scheduled")?.handler).toBe(other);
    expect(build.registry.resolve("reorder-stock", "scheduled")?.handler).toBe(handler);
  });

  it("does not cover a deprecated declaration with a kind provider", () => {
    const old = job("retired", CRON, { deprecated: true });
    const build = buildJobHandlerRegistry({
      jobs: [sweep, old],
      providers: [{ serves: "kind", jobKind: "scheduled", handler }],
    });
    expect(build.registry.resolve("retired", "scheduled")).toBeUndefined();
    expect(build.servedJobIds).toEqual(["sweep-invoices"]);
  });

  it("refuses a provider for an undeclared job, naming what is declared", () => {
    expect(() =>
      buildJobHandlerRegistry({ jobs: [sweep], providers: [{ serves: "job", jobId: "sweap-invoices", handler }] }),
    ).toThrow(/undeclared|no job declaration holds/);
    try {
      buildJobHandlerRegistry({ jobs: [sweep], providers: [{ serves: "job", jobId: "typo", handler }] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JobHandlerBuildError);
      expect((err as JobHandlerBuildError).code).toBe("undeclared_job");
      expect((err as JobHandlerBuildError).message).toContain("sweep-invoices");
    }
  });

  it("refuses two job providers for one job id rather than silently picking one", () => {
    try {
      buildJobHandlerRegistry({
        jobs: [sweep],
        providers: [
          { serves: "job", jobId: "sweep-invoices", handler },
          { serves: "job", jobId: "sweep-invoices", handler: other },
        ],
      });
      expect.unreachable();
    } catch (err) {
      expect((err as JobHandlerBuildError).code).toBe("duplicate_provider");
    }
  });

  it("refuses two kind providers for one kind", () => {
    try {
      buildJobHandlerRegistry({
        jobs: [sweep],
        providers: [
          { serves: "kind", jobKind: "scheduled", handler },
          { serves: "kind", jobKind: "scheduled", handler: other },
        ],
      });
      expect.unreachable();
    } catch (err) {
      expect((err as JobHandlerBuildError).code).toBe("duplicate_provider");
    }
  });

  it("refuses a kind provider that covers no declaration", () => {
    try {
      buildJobHandlerRegistry({ jobs: [sweep], providers: [{ serves: "kind", jobKind: "event", handler }] });
      expect.unreachable();
    } catch (err) {
      expect((err as JobHandlerBuildError).code).toBe("kind_serves_nothing");
    }
  });

  it("refuses a kind provider covering only deprecated declarations", () => {
    const old = job("retired", EVENT, { deprecated: true });
    try {
      buildJobHandlerRegistry({ jobs: [old], providers: [{ serves: "kind", jobKind: "event", handler }] });
      expect.unreachable();
    } catch (err) {
      expect((err as JobHandlerBuildError).code).toBe("kind_serves_nothing");
    }
  });

  it("refuses a provider that restates the retry policy", () => {
    const sneaky = { serves: "job", jobId: "sweep-invoices", handler, retry: { maxAttempts: 99 } };
    try {
      buildJobHandlerRegistry({ jobs: [sweep], providers: [sneaky as unknown as JobHandlerProvider] });
      expect.unreachable();
    } catch (err) {
      expect((err as JobHandlerBuildError).code).toBe("provider_overrides_declared_retry");
    }
  });

  it("refuses a provider that restates maxAttempts", () => {
    const sneaky = { serves: "job", jobId: "sweep-invoices", handler, maxAttempts: 99 };
    try {
      buildJobHandlerRegistry({ jobs: [sweep], providers: [sneaky as unknown as JobHandlerProvider] });
      expect.unreachable();
    } catch (err) {
      expect((err as JobHandlerBuildError).code).toBe("provider_overrides_declared_retry");
    }
  });

  it("builds from no providers at all, and the survey says every job is unservable", () => {
    const build = buildJobHandlerRegistry({ jobs: [sweep, onPayment], providers: [] });
    expect(build.servedJobIds).toEqual([]);
    expect(build.survey.unservable).toEqual(["sweep-invoices", "on-payment"]);
    expect(build.survey.findings.map((f) => f.verdict)).toEqual(["handler_missing", "handler_missing"]);
  });

  it("builds from no declarations at all", () => {
    const build = buildJobHandlerRegistry({ jobs: [], providers: [] });
    expect(build.servedJobIds).toEqual([]);
    expect(build.survey.findings).toEqual([]);
  });

  it("reports a served job whose kind no producer enqueues as no_producer, not as served", () => {
    const cdc = job("on-row", { kind: "cdc", table: "invoices", operation: "any" });
    const build = buildJobHandlerRegistry({
      jobs: [cdc],
      providers: [{ serves: "job", jobId: "on-row", handler }],
    });
    expect(build.survey.findings[0]?.verdict).toBe("no_producer");
    expect(build.servedJobIds).toEqual([]);
    // The handler is registered all the same: the refusal is about the producer, not the wiring.
    expect(build.registry.resolve("on-row", "cdc")?.handler).toBe(handler);
  });

  it("servedJobIds and survey.served are one list, not two", () => {
    const build = buildJobHandlerRegistry({
      jobs: [sweep, reorder],
      providers: [{ serves: "job", jobId: "reorder-stock", handler }],
    });
    expect(build.servedJobIds).toBe(build.survey.served);
  });

  it("registers in declaration order so servedJobIds is stable across builds", () => {
    const providers: readonly JobHandlerProvider[] = [
      { serves: "job", jobId: "on-payment", handler },
      { serves: "job", jobId: "sweep-invoices", handler },
    ];
    const build = buildJobHandlerRegistry({ jobs: [sweep, onPayment], providers });
    expect(build.servedJobIds).toEqual(["sweep-invoices", "on-payment"]);
  });
});
