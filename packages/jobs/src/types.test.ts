import { describe, expect, it } from "vitest";
import {
  ConcurrencySchema,
  CronExpressionSchema,
  DEFAULT_RETRIES,
  EventNameSchema,
  Iso8601DurationSchema,
  JOB_KINDS,
  JOB_TIER_DEFAULT_CONCURRENCY,
  JOB_TIERS,
  JobDeclarationSchema,
  JobIdSchema,
  JobRegistrySchema,
  JobTriggerSchema,
  RateLimitDeclarationSchema,
  RateLimitSchema,
  RetryPolicySchema,
  durationToMillis,
} from "./types.js";

describe("JobIdSchema", () => {
  it("accepts kebab-case ids", () => {
    expect(JobIdSchema.parse("notify-patient")).toBe("notify-patient");
    expect(JobIdSchema.parse("a")).toBe("a");
    expect(JobIdSchema.parse("scan-virus-1")).toBe("scan-virus-1");
  });

  it("rejects uppercase", () => {
    expect(() => JobIdSchema.parse("NotifyPatient")).toThrow();
  });

  it("rejects leading/trailing hyphens", () => {
    expect(() => JobIdSchema.parse("-leading")).toThrow();
    expect(() => JobIdSchema.parse("trailing-")).toThrow();
  });

  it("rejects underscores", () => {
    expect(() => JobIdSchema.parse("notify_patient")).toThrow();
  });
});

describe("EventNameSchema", () => {
  it("accepts dotted snake_case", () => {
    expect(EventNameSchema.parse("prescription.verified")).toBe("prescription.verified");
    expect(EventNameSchema.parse("ai_architect.conversation.completed")).toBe(
      "ai_architect.conversation.completed",
    );
  });

  it("rejects a single-segment name", () => {
    expect(() => EventNameSchema.parse("prescription")).toThrow();
  });

  it("rejects uppercase", () => {
    expect(() => EventNameSchema.parse("Prescription.Verified")).toThrow();
  });
});

describe("CronExpressionSchema", () => {
  it("accepts standard 5-field crontab", () => {
    expect(CronExpressionSchema.parse("0 6 * * *")).toBe("0 6 * * *");
    expect(CronExpressionSchema.parse("*/15 * * * *")).toBe("*/15 * * * *");
    expect(CronExpressionSchema.parse("0 0 1 * *")).toBe("0 0 1 * *");
  });

  it("accepts 6-field crontab (with seconds)", () => {
    expect(CronExpressionSchema.parse("0 0 6 * * *")).toBe("0 0 6 * * *");
  });

  it("rejects free text", () => {
    expect(() => CronExpressionSchema.parse("every 5 minutes")).toThrow();
  });

  it("rejects too few fields", () => {
    expect(() => CronExpressionSchema.parse("0 6 * *")).toThrow();
  });
});

describe("Iso8601DurationSchema", () => {
  it("accepts valid durations", () => {
    expect(Iso8601DurationSchema.parse("PT5M")).toBe("PT5M");
    expect(Iso8601DurationSchema.parse("P28D")).toBe("P28D");
    expect(Iso8601DurationSchema.parse("PT1H30M")).toBe("PT1H30M");
  });

  it("rejects empty forms", () => {
    expect(() => Iso8601DurationSchema.parse("P")).toThrow();
    expect(() => Iso8601DurationSchema.parse("PT")).toThrow();
  });

  it("rejects free text", () => {
    expect(() => Iso8601DurationSchema.parse("5 minutes")).toThrow();
  });
});

describe("RateLimitSchema", () => {
  it("accepts shape '<count>/<unit>'", () => {
    expect(RateLimitSchema.parse("200/min")).toBe("200/min");
    expect(RateLimitSchema.parse("60/sec")).toBe("60/sec");
    expect(RateLimitSchema.parse("1000/hour")).toBe("1000/hour");
  });

  it("rejects unsupported unit", () => {
    expect(() => RateLimitSchema.parse("100/year")).toThrow();
  });
});

describe("JobTriggerSchema", () => {
  it("parses event trigger", () => {
    const t = JobTriggerSchema.parse({ kind: "event", eventName: "prescription.verified" });
    expect(t.kind).toBe("event");
  });

  it("parses scheduled trigger with timezone", () => {
    const t = JobTriggerSchema.parse({
      kind: "scheduled",
      cron: "0 6 * * *",
      timezone: "Asia/Dubai",
    });
    expect(t.kind).toBe("scheduled");
    if (t.kind === "scheduled") expect(t.timezone).toBe("Asia/Dubai");
  });

  it("parses delayed trigger", () => {
    const t = JobTriggerSchema.parse({
      kind: "delayed",
      afterEvent: "vaccination.dose_1_given",
      delay: "P28D",
    });
    expect(t.kind).toBe("delayed");
  });

  it("parses userInvoked trigger", () => {
    const t = JobTriggerSchema.parse({ kind: "userInvoked", action: "pdf.generate" });
    expect(t.kind).toBe("userInvoked");
  });

  it("parses workflow trigger", () => {
    const t = JobTriggerSchema.parse({
      kind: "workflow",
      workflow: "prescription_lifecycle",
      step: "humanTask",
    });
    expect(t.kind).toBe("workflow");
  });

  it("parses cdc trigger", () => {
    const t = JobTriggerSchema.parse({
      kind: "cdc",
      table: "prescriptions",
      operation: "insert",
    });
    expect(t.kind).toBe("cdc");
  });

  it("rejects an unknown kind", () => {
    expect(() => JobTriggerSchema.parse({ kind: "manual" })).toThrow();
  });
});

describe("ConcurrencySchema", () => {
  it("defaults the key to event.data.tenant_id", () => {
    const c = ConcurrencySchema.parse({ limit: 50 });
    expect(c.key).toBe("event.data.tenant_id");
  });

  it("accepts a per-field key", () => {
    const c = ConcurrencySchema.parse({ limit: 10, key: "event.data.patient_id" });
    expect(c.key).toBe("event.data.patient_id");
  });

  it("rejects non-positive limits", () => {
    expect(() => ConcurrencySchema.parse({ limit: 0 })).toThrow();
    expect(() => ConcurrencySchema.parse({ limit: -1 })).toThrow();
  });

  it("rejects key not rooted at event.data", () => {
    expect(() => ConcurrencySchema.parse({ limit: 10, key: "tenant_id" })).toThrow();
  });
});

describe("RateLimitDeclarationSchema", () => {
  it("parses with period enum", () => {
    const r = RateLimitDeclarationSchema.parse({ limit: 200, period: "min" });
    expect(r.period).toBe("min");
    expect(r.key).toBe("event.data.tenant_id");
  });
});

describe("RetryPolicySchema", () => {
  it("parses with backoff", () => {
    const r = RetryPolicySchema.parse({
      maxAttempts: 5,
      backoff: {
        kind: "exponential",
        initialDelay: "PT1S",
        maxDelay: "PT60S",
        jitter: true,
      },
    });
    expect(r.maxAttempts).toBe(5);
  });

  it("rejects maxAttempts > 20", () => {
    expect(() => RetryPolicySchema.parse({ maxAttempts: 21 })).toThrow();
  });

  it("rejects maxDelay < initialDelay", () => {
    expect(() =>
      RetryPolicySchema.parse({
        maxAttempts: 3,
        backoff: { kind: "linear", initialDelay: "PT10S", maxDelay: "PT1S" },
      }),
    ).toThrow();
  });
});

describe("JobDeclarationSchema", () => {
  const ok = {
    id: "notify-patient",
    name: "Notify Patient",
    trigger: { kind: "event" as const, eventName: "prescription.verified" },
    onFailure: { strategy: "alert-and-dead-letter" as const },
  };

  it("parses a minimal declaration", () => {
    const j = JobDeclarationSchema.parse(ok);
    expect(j.idempotent).toBe(true);
    expect(j.inputDataClass).toBe("internal");
    expect(j.outputDataClass).toBe("internal");
  });

  it("parses a declaration with concurrency + rateLimit + retry", () => {
    const j = JobDeclarationSchema.parse({
      ...ok,
      concurrency: { limit: 50 },
      rateLimit: { limit: 200, period: "min" },
      retry: { maxAttempts: 5 },
    });
    expect(j.concurrency?.limit).toBe(50);
    expect(j.rateLimit?.period).toBe("min");
    expect(j.retry?.maxAttempts).toBe(5);
  });

  it("parses PHI data classes", () => {
    const j = JobDeclarationSchema.parse({
      ...ok,
      inputDataClass: "phi",
      outputDataClass: "phi",
    });
    expect(j.inputDataClass).toBe("phi");
  });

  it("rejects swallow-and-log on a non-idempotent scheduled job", () => {
    expect(() =>
      JobDeclarationSchema.parse({
        id: "x",
        name: "x",
        trigger: { kind: "scheduled", cron: "0 6 * * *" },
        onFailure: { strategy: "swallow-and-log" },
        idempotent: false,
      }),
    ).toThrow();
  });

  it("accepts swallow-and-log on an idempotent scheduled job", () => {
    expect(() =>
      JobDeclarationSchema.parse({
        id: "x",
        name: "x",
        trigger: { kind: "scheduled", cron: "0 6 * * *" },
        onFailure: { strategy: "swallow-and-log" },
        idempotent: true,
      }),
    ).not.toThrow();
  });

  it("rejects unknown onFailure strategy", () => {
    expect(() =>
      JobDeclarationSchema.parse({ ...ok, onFailure: { strategy: "ignore" } }),
    ).toThrow();
  });
});

describe("JobRegistrySchema", () => {
  const j = (id: string) => ({
    id,
    name: id,
    trigger: { kind: "event" as const, eventName: "x.y" },
    onFailure: { strategy: "dead-letter" as const },
  });

  it("accepts unique job ids", () => {
    expect(() => JobRegistrySchema.parse([j("a"), j("b")])).not.toThrow();
  });

  it("rejects duplicate ids", () => {
    expect(() => JobRegistrySchema.parse([j("a"), j("a")])).toThrow();
  });
});

describe("durationToMillis", () => {
  it("converts simple units", () => {
    expect(durationToMillis("PT1S")).toBe(1000);
    expect(durationToMillis("PT1M")).toBe(60_000);
    expect(durationToMillis("PT1H")).toBe(3_600_000);
    expect(durationToMillis("P1D")).toBe(86_400_000);
  });

  it("converts compound durations", () => {
    expect(durationToMillis("PT1H30M")).toBe(5_400_000);
    expect(durationToMillis("P1DT12H")).toBe(86_400_000 + 12 * 3_600_000);
  });

  it("throws on malformed input", () => {
    expect(() => durationToMillis("5 minutes")).toThrow();
  });
});

describe("constants", () => {
  it("JOB_KINDS has six values", () => {
    expect(JOB_KINDS).toHaveLength(6);
  });

  it("DEFAULT_RETRIES covers every kind", () => {
    for (const k of JOB_KINDS) {
      expect(DEFAULT_RETRIES[k]).toBeGreaterThan(0);
    }
  });

  it("JOB_TIERS has five tiers with ascending defaults", () => {
    expect(JOB_TIERS).toHaveLength(5);
    let prior = 0;
    for (const t of JOB_TIERS) {
      const v = JOB_TIER_DEFAULT_CONCURRENCY[t];
      expect(v).toBeGreaterThan(prior);
      prior = v;
    }
  });
});

describe("JobTriggerSchema refuses a schedule it cannot serve", () => {
  const scheduled = (cron: string, timezone?: string): unknown => ({
    kind: "scheduled",
    cron,
    ...(timezone !== undefined ? { timezone } : {}),
  });

  it("accepts what the seven shipped packs declare", () => {
    for (const cron of ["0 * * * *", "0 5 * * *", "0 6 * * *", "0 7 * * *"]) {
      expect(JobTriggerSchema.safeParse(scheduled(cron, "UTC")).success, cron).toBe(true);
    }
  });

  it("refuses an unresolvable timezone, naming the field", () => {
    // Before this it fell through to UTC in silence: a month-end close declared in Asia/Tokyo ran
    // nine hours early, every month, with nothing anywhere to look at.
    const result = JobTriggerSchema.safeParse(scheduled("0 0 * * *", "Erope/London"));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a refusal");
    expect(result.error.issues[0]?.path).toEqual(["timezone"]);
    expect(result.error.issues[0]?.message).toContain("not resolvable");
  });

  it("refuses a cron that can never match a real date, naming the field", () => {
    const result = JobTriggerSchema.safeParse(scheduled("0 0 30 2 *"));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a refusal");
    expect(result.error.issues[0]?.path).toEqual(["cron"]);
    expect(result.error.issues[0]?.message).toContain("never match");
  });

  it("accepts 29 February, which does fire", () => {
    expect(JobTriggerSchema.safeParse(scheduled("0 0 29 2 *", "UTC")).success).toBe(true);
  });

  it("accepts an absent timezone, which means UTC", () => {
    expect(JobTriggerSchema.safeParse(scheduled("0 0 * * *")).success).toBe(true);
  });

  it("still refuses a malformed expression through the expression schema", () => {
    expect(JobTriggerSchema.safeParse(scheduled("not a cron")).success).toBe(false);
  });

  it("leaves every other trigger kind untouched", () => {
    expect(JobTriggerSchema.safeParse({ kind: "event", eventName: "invoice.posted" }).success).toBe(true);
    expect(JobTriggerSchema.safeParse({ kind: "userInvoked", action: "recalc" }).success).toBe(true);
    expect(JobTriggerSchema.safeParse({ kind: "cdc", table: "t", operation: "any" }).success).toBe(true);
  });

  it("keeps the discriminated union's narrowing, which a ZodEffects member would have destroyed", () => {
    // Found while writing this: passing a `.superRefine()`d member to `z.discriminatedUnion` does
    // not error at the union — it degrades every reader's `trigger.kind` to `unknown`. Hence the
    // refinement living on the union instead.
    const parsed = JobTriggerSchema.parse(scheduled("0 0 * * *", "UTC"));
    expect(parsed.kind).toBe("scheduled");
    if (parsed.kind !== "scheduled") throw new Error("narrowing lost");
    expect(parsed.cron).toBe("0 0 * * *");
  });
});
