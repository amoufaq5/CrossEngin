import type {
  PageChannelOutcome,
  PageDeliveryReport,
} from "@crossengin/notification-providers";
import { describe, expect, it } from "vitest";

import {
  PAGE_DELIVERED_OPERATION,
  PAGE_RECORD_ENTITY,
  PAGE_UNDELIVERED_OPERATION,
  PageRecorder,
  formatPageRecord,
  pageRecordOperation,
} from "./page-record.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const INCIDENT = "INC-2026-0001";

type Emitted = {
  operation: string;
  tenantId: string | null;
  entity: string;
  entityId: string | null;
  occurredAt: string;
  actor: unknown;
  reason: string | undefined;
  after: Record<string, unknown> | null;
};

/**
 * Records what the emitter was asked to write, without a database — the project's rule for
 * Postgres-backed modules. `throwOn` makes the emitter fail the way an unreachable chain would.
 */
function fakeAudit(throwOn?: Error) {
  const emitted: Emitted[] = [];
  return {
    emitted,
    audit: {
      emit: async (entry: {
        operation: string;
        tenantId: string | null;
        entity: string;
        entityId: string | null;
        occurredAt: string;
        actor: unknown;
        reason?: string;
        after: Record<string, unknown> | null;
      }): Promise<void> => {
        if (throwOn !== undefined) throw throwOn;
        emitted.push({
          operation: entry.operation,
          tenantId: entry.tenantId,
          entity: entry.entity,
          entityId: entry.entityId,
          occurredAt: entry.occurredAt,
          actor: entry.actor,
          reason: entry.reason,
          after: entry.after,
        });
      },
    } as never,
  };
}

/**
 * Built by spread rather than as a fresh literal on purpose: `PageChannelOutcome` is being extended
 * in the package next door (`attemptsMade` arrived mid-change), and a spread is exempt from excess
 * property checking — so this fixture compiles against the shape before and after.
 */
type OutcomeOver = Partial<PageChannelOutcome> & { readonly attemptsMade?: number };

function outcome(over: OutcomeOver = {}): PageChannelOutcome {
  const base = {
    kind: "pagerduty_phone",
    disposition: "delivered" as const,
    provider: "pagerduty",
    httpStatus: 202,
    reference: "ref-1",
    errorMessage: null,
    attemptsMade: 1,
    retryAfterMs: null,
    waitedMs: 0,
  };
  return { ...base, ...over };
}

function report(over: Partial<PageDeliveryReport> = {}): PageDeliveryReport {
  const outcomes = over.outcomes ?? [outcome()];
  const delivered = outcomes.filter((o) => o.disposition === "delivered").length;
  const settled = ["unroutable", "no_address", "unsupported"];
  const attempted = outcomes.filter((o) => !settled.includes(o.disposition)).length;
  const base = {
    incidentId: INCIDENT,
    attempted,
    delivered,
    undelivered: outcomes.length > 0 && delivered === 0,
    outcomes,
  };
  return { ...base, ...over };
}

const outcomesOf = (e: Emitted): readonly Record<string, unknown>[] =>
  (e.after?.["outcomes"] ?? []) as readonly Record<string, unknown>[];

describe("page record operations", () => {
  it("names the delivered and undelivered facts separately", () => {
    expect(PAGE_DELIVERED_OPERATION).toBe("platform.page_delivered");
    expect(PAGE_UNDELIVERED_OPERATION).toBe("platform.page_undelivered");
    expect(PAGE_DELIVERED_OPERATION).not.toBe(PAGE_UNDELIVERED_OPERATION);
  });

  it("records a page as a fact about an incident", () => {
    expect(PAGE_RECORD_ENTITY).toBe("incident");
  });

  it("chooses the operation on whether anything was delivered", () => {
    expect(pageRecordOperation(report())).toBe(PAGE_DELIVERED_OPERATION);
    expect(pageRecordOperation(report({ outcomes: [outcome({ disposition: "failed" })] }))).toBe(
      PAGE_UNDELIVERED_OPERATION,
    );
  });

  it("calls a directive with no channels undelivered, though its `undelivered` flag is false", () => {
    const zero = report({ outcomes: [] });
    expect(zero.undelivered).toBe(false);
    expect(pageRecordOperation(zero)).toBe(PAGE_UNDELIVERED_OPERATION);
  });
});

describe("PageRecorder.record", () => {
  it("writes a delivered page under the delivered operation", async () => {
    const { audit, emitted } = fakeAudit();
    const recorder = new PageRecorder({ audit, tenantIdFor: () => TENANT_A });
    const outcomeOf = await recorder.record(report());
    expect(outcomeOf).toEqual({ audited: true, reason: null });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      operation: PAGE_DELIVERED_OPERATION,
      tenantId: TENANT_A,
      entity: PAGE_RECORD_ENTITY,
      entityId: INCIDENT,
    });
  });

  it("writes an undelivered page under the undelivered operation", async () => {
    const { audit, emitted } = fakeAudit();
    const recorder = new PageRecorder({ audit, tenantIdFor: () => TENANT_A });
    const res = await recorder.record(
      report({ outcomes: [outcome({ disposition: "failed", httpStatus: null })] }),
    );
    expect(res.audited).toBe(true);
    expect(emitted[0]?.operation).toBe(PAGE_UNDELIVERED_OPERATION);
  });

  it("gives each operation its own reason, so the row reads without the payload", async () => {
    const { audit, emitted } = fakeAudit();
    const recorder = new PageRecorder({ audit, tenantIdFor: () => TENANT_A });
    await recorder.record(report());
    await recorder.record(report({ outcomes: [outcome({ disposition: "rejected" })] }));
    expect(emitted[0]?.reason).toContain("delivered");
    expect(emitted[1]?.reason).toContain("not delivered");
    expect(emitted[0]?.reason).not.toBe(emitted[1]?.reason);
  });

  it("attributes the row to the system, not to a user", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit, tenantIdFor: () => TENANT_A }).record(report());
    expect(emitted[0]?.actor).toMatchObject({ kind: "system", userId: null });
  });

  it("carries the counts the dispatcher reported, including the undelivered flag", async () => {
    const { audit, emitted } = fakeAudit();
    const recorder = new PageRecorder({ audit, tenantIdFor: () => TENANT_A });
    await recorder.record(
      report({
        outcomes: [
          outcome({ disposition: "failed" }),
          outcome({ kind: "slack", disposition: "unroutable", provider: null, httpStatus: null }),
        ],
      }),
    );
    expect(emitted[0]?.after).toMatchObject({
      incidentId: INCIDENT,
      attempted: 1,
      delivered: 0,
      undelivered: true,
    });
  });

  it("carries every per-channel outcome as the evidence", async () => {
    const { audit, emitted } = fakeAudit();
    const recorder = new PageRecorder({ audit, tenantIdFor: () => TENANT_A });
    await recorder.record(
      report({
        outcomes: [
          outcome(),
          outcome({
            kind: "slack",
            disposition: "rejected",
            provider: "slack",
            httpStatus: 200,
            reference: null,
            errorMessage: "channel_not_found",
          }),
        ],
      }),
    );
    const rows = outcomesOf(emitted[0] as Emitted);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      kind: "pagerduty_phone",
      disposition: "delivered",
      provider: "pagerduty",
      httpStatus: 202,
      reference: "ref-1",
      errorMessage: null,
      attemptsMade: 1,
      retryAfterMs: null,
      waitedMs: 0,
    });
    expect(rows[1]).toMatchObject({
      kind: "slack",
      disposition: "rejected",
      httpStatus: 200,
      errorMessage: "channel_not_found",
    });
  });

  it("records how many times each transport was called", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit, tenantIdFor: () => TENANT_A }).record(
      report({ outcomes: [outcome({ disposition: "failed", attemptsMade: 3 })] }),
    );
    expect(outcomesOf(emitted[0] as Emitted)[0]).toMatchObject({ attemptsMade: 3 });
  });

  it("records what the provider said about when to come back", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit }).record(
      report({ outcomes: [outcome({ disposition: "failed", httpStatus: 429, retryAfterMs: 45_000 })] }),
      TENANT_A,
    );
    // On a page that burned its whole budget this is the sharpest field on the row: "PagerDuty asked
    // for 45s and we stopped" is a different finding from "the transport was down" (ADR-0327).
    expect(outcomesOf(emitted[0] as Emitted)[0]).toMatchObject({ retryAfterMs: 45_000 });
  });

  it("records how long the page spent waiting before it settled", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit }).record(
      report({ outcomes: [outcome({ disposition: "failed", attemptsMade: 3, waitedMs: 11_400 })] }),
      TENANT_A,
    );
    // "Retried three times" and "retried three times over eleven seconds" are different answers to
    // "why did nobody come" (ADR-0328).
    expect(outcomesOf(emitted[0] as Emitted)[0]).toMatchObject({ waitedMs: 11_400 });
  });

  it("records an absent Retry-After as null, never as zero", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit }).record(report(), TENANT_A);
    // Zero would read as "come back immediately", which is an instruction nobody gave.
    expect(outcomesOf(emitted[0] as Emitted)[0]).toMatchObject({ retryAfterMs: null });
  });

  it("records an unreported attempt count as null, never as zero", async () => {
    const { audit, emitted } = fakeAudit();
    const bare = {
      kind: "slack",
      disposition: "delivered",
      provider: "slack",
      httpStatus: 200,
      reference: null,
      errorMessage: null,
    } as PageChannelOutcome;
    await new PageRecorder({ audit, tenantIdFor: () => TENANT_A }).record(
      report({ outcomes: [bare] }),
    );
    expect(outcomesOf(emitted[0] as Emitted)[0]).toMatchObject({ attemptsMade: null });
  });

  it("records exactly the evidence fields of an outcome and no others", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit, tenantIdFor: () => TENANT_A }).record(report());
    expect(Object.keys(outcomesOf(emitted[0] as Emitted)[0] ?? {}).sort()).toEqual([
      "attemptsMade",
      "disposition",
      "errorMessage",
      "httpStatus",
      "kind",
      "provider",
      "reference",
      // Added deliberately, not by accident: this list is the guard that makes a new field on
      // `PageChannelOutcome` a decision here rather than a silent passthrough. It caught
      // `retryAfterMs` the moment the dispatcher grew it (ADR-0327) and `waitedMs` the next time
      // (ADR-0328).
      "retryAfterMs",
      "waitedMs",
    ]);
  });

  it("keeps a mix of dispositions distinct rather than collapsing them", async () => {
    const { audit, emitted } = fakeAudit();
    const recorder = new PageRecorder({ audit, tenantIdFor: () => TENANT_A });
    await recorder.record(
      report({
        outcomes: [
          outcome(),
          outcome({ kind: "slack", disposition: "failed", provider: "slack", httpStatus: null }),
          outcome({
            kind: "sms",
            disposition: "unroutable",
            provider: null,
            httpStatus: null,
            attemptsMade: 0,
          }),
          outcome({ kind: "webhook", disposition: "no_address", attemptsMade: 0 }),
        ],
      }),
    );
    expect(outcomesOf(emitted[0] as Emitted).map((o) => o["disposition"])).toEqual([
      "delivered",
      "failed",
      "unroutable",
      "no_address",
    ]);
    // One channel took it, so the page arrived — delivered, despite three failures beside it.
    expect(emitted[0]?.operation).toBe(PAGE_DELIVERED_OPERATION);
  });

  it("records a report with no channels at all, as undelivered with an empty outcome list", async () => {
    const { audit, emitted } = fakeAudit();
    const recorder = new PageRecorder({ audit, tenantIdFor: () => TENANT_A });
    const res = await recorder.record(report({ outcomes: [] }));
    expect(res).toEqual({ audited: true, reason: null });
    expect(emitted[0]?.operation).toBe(PAGE_UNDELIVERED_OPERATION);
    expect(emitted[0]?.after).toMatchObject({ attempted: 0, delivered: 0, undelivered: false });
    expect(outcomesOf(emitted[0] as Emitted)).toEqual([]);
  });

  it("carries nothing beyond the incident id, the counts and the outcomes", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit, tenantIdFor: () => TENANT_A }).record(report());
    expect(Object.keys(emitted[0]?.after ?? {}).sort()).toEqual([
      "attempted",
      "delivered",
      "incidentId",
      "outcomes",
      "undelivered",
    ]);
  });

  it("never puts the tenant id in the payload — it is the row's scope, not evidence", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit, tenantIdFor: () => TENANT_A }).record(report());
    expect(JSON.stringify(emitted[0]?.after)).not.toContain(TENANT_A);
    expect(emitted[0]?.tenantId).toBe(TENANT_A);
  });

  it("stamps occurredAt from the injected clock", async () => {
    const { audit, emitted } = fakeAudit();
    const at = new Date("2026-10-03T03:14:00.000Z");
    const recorder = new PageRecorder({
      audit,
      tenantIdFor: () => TENANT_A,
      clock: () => at,
    });
    await recorder.record(report());
    expect(emitted[0]?.occurredAt).toBe("2026-10-03T03:14:00.000Z");
  });

  it("reads the clock per record, so two pages are not stamped alike", async () => {
    const { audit, emitted } = fakeAudit();
    const times = ["2026-10-03T03:14:00.000Z", "2026-10-03T04:15:00.000Z"];
    let i = 0;
    const recorder = new PageRecorder({
      audit,
      tenantIdFor: () => TENANT_A,
      clock: () => new Date(times[i++] ?? times[1] ?? ""),
    });
    await recorder.record(report());
    await recorder.record(report());
    expect(emitted.map((e) => e.occurredAt)).toEqual(times);
  });

  it("gives each record its own id, since the log is append-only", async () => {
    const seen: string[] = [];
    const audit = {
      emit: async (entry: { id: string }): Promise<void> => {
        seen.push(entry.id);
      },
    } as never;
    const recorder = new PageRecorder({ audit, tenantIdFor: () => TENANT_A });
    await recorder.record(report());
    await recorder.record(report());
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("reports audited:false with a reason when no emitter is configured", async () => {
    const res = await new PageRecorder({ tenantIdFor: () => TENANT_A }).record(report());
    expect(res.audited).toBe(false);
    expect(res.reason).toContain("no audit emitter");
  });

  it("does not treat a missing emitter as an error", async () => {
    const errors: unknown[] = [];
    const res = await new PageRecorder({
      tenantIdFor: () => TENANT_A,
      onError: (e) => errors.push(e),
    }).record(report());
    expect(res.audited).toBe(false);
    expect(errors).toEqual([]);
  });

  it("records a platform-scope page at platform scope (ADR-0331)", async () => {
    const { audit, emitted } = fakeAudit();
    const res = await new PageRecorder({ audit, tenantIdFor: () => null }).record(report());
    expect(res.audited).toBe(true);
    expect(res.reason).toBeNull();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.tenantId).toBeNull();
  });

  it("does not invent a tenant id when the scope is the platform", async () => {
    // The row that lands names no tenant at all. That is the whole distinction from ADR-0327's
    // rejected Option B, which would have filed it under a tenant the page is not about.
    const { audit, emitted } = fakeAudit();
    const res = await new PageRecorder({ audit }).record(report());
    expect(res.audited).toBe(true);
    expect(emitted[0]?.tenantId).toBeNull();
  });

  it("treats an empty-string tenant id as no tenant rather than emitting one", async () => {
    const { audit, emitted } = fakeAudit();
    const res = await new PageRecorder({ audit, tenantIdFor: () => "" }).record(report());
    expect(res.audited).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("passes the report to tenantIdFor, so the resolver can scope on the incident", async () => {
    const seen: PageDeliveryReport[] = [];
    const { audit } = fakeAudit();
    const r = report();
    await new PageRecorder({
      audit,
      tenantIdFor: (rep) => {
        seen.push(rep);
        return TENANT_A;
      },
    }).record(r);
    expect(seen).toEqual([r]);
  });

  it("does not throw when the emitter throws — the page already went out", async () => {
    const { audit } = fakeAudit(new Error("audit chain unreachable"));
    const errors: unknown[] = [];
    const res = await new PageRecorder({
      audit,
      tenantIdFor: () => TENANT_A,
      onError: (e) => errors.push(e),
    }).record(report());
    expect(res.audited).toBe(false);
    expect(res.reason).toContain("audit chain unreachable");
    expect(errors).toHaveLength(1);
  });

  it("survives an emitter that throws with no onError wired", async () => {
    const { audit } = fakeAudit(new Error("boom"));
    const res = await new PageRecorder({ audit, tenantIdFor: () => TENANT_A }).record(report());
    expect(res).toEqual({ audited: false, reason: "audit emit failed: boom" });
  });

  it("reports a non-Error throw as its string form", async () => {
    const audit = {
      emit: async (): Promise<void> => {
        throw "nope";
      },
    } as never;
    const res = await new PageRecorder({ audit, tenantIdFor: () => TENANT_A }).record(report());
    expect(res.audited).toBe(false);
    expect(res.reason).toContain("nope");
  });

  it("does not let a throwing tenant resolver escape either", async () => {
    const { audit, emitted } = fakeAudit();
    const errors: unknown[] = [];
    const res = await new PageRecorder({
      audit,
      tenantIdFor: () => {
        throw new Error("directory down");
      },
      onError: (e) => errors.push(e),
    }).record(report());
    expect(res.audited).toBe(false);
    expect(emitted).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

/**
 * The caller supplies the tenant because nothing in the report can answer for it (ADR-0326).
 *
 * ADR-0325's content rule is that a page carries no tenant data, so a `tenantIdFor(report)`
 * resolver has nothing to resolve *from* — the escalator that initiated the page is the only party
 * that knows, and it holds the `IncidentRecord` it just declared.
 */
describe("PageRecorder.record with a caller-supplied tenant", () => {
  const TENANT_B = "22222222-2222-2222-2222-222222222222";

  it("scopes the row to the tenant the caller supplied", async () => {
    const { audit, emitted } = fakeAudit();
    const res = await new PageRecorder({ audit }).record(report(), TENANT_A);
    expect(res.audited).toBe(true);
    expect(emitted[0]?.tenantId).toBe(TENANT_A);
  });

  it("records with no resolver wired at all, which is the wiring every escalator uses", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit }).record(report(), TENANT_A);
    expect(emitted).toHaveLength(1);
  });

  it("prefers the supplied tenant over the resolver, since the caller holds the incident", async () => {
    const { audit, emitted } = fakeAudit();
    let asked = 0;
    await new PageRecorder({
      audit,
      tenantIdFor: () => {
        asked += 1;
        return TENANT_B;
      },
    }).record(report(), TENANT_A);
    expect(emitted[0]?.tenantId).toBe(TENANT_A);
    // Not merely overridden — not consulted. A directory lookup for an answer already in hand is
    // a failure mode (ADR-0326's resolver may consult one), not just waste.
    expect(asked).toBe(0);
  });

  it("falls back to the resolver when the caller supplies null, for a caller with a directory", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit, tenantIdFor: () => TENANT_B }).record(report(), null);
    expect(emitted[0]?.tenantId).toBe(TENANT_B);
  });

  it("records at platform scope when the caller supplies null and no resolver answers", async () => {
    // This is the SLO loop's case: `deliverAndRecord(sloPager, directive, "slo", null)`. An SLO
    // surface is never a tenant, so before ADR-0331 this page left no evidence at all.
    const { audit, emitted } = fakeAudit();
    const res = await new PageRecorder({ audit }).record(report(), null);
    expect(res.audited).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.tenantId).toBeNull();
  });

  it("does not read a resolver that THREW as platform scope", async () => {
    // A failure to find out is not a claim about the deployment. The page already went out, so
    // this is reported and not raised.
    const errors: unknown[] = [];
    const { audit, emitted } = fakeAudit();
    const res = await new PageRecorder({
      audit,
      tenantIdFor: () => {
        throw new Error("directory down");
      },
      onError: (e) => errors.push(e),
    }).record(report());
    expect(res.audited).toBe(false);
    expect(res.reason).toContain("could not resolve");
    expect(emitted).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("does not read a blank resolved scope as platform scope", async () => {
    const { audit, emitted } = fakeAudit();
    const res = await new PageRecorder({ audit, tenantIdFor: () => "  " }).record(report());
    expect(res.audited).toBe(false);
    expect(res.reason).toContain("blank");
    expect(emitted).toEqual([]);
  });

  it("treats a blank supplied tenant as no answer, not as platform scope", async () => {
    const { audit, emitted } = fakeAudit();
    const res = await new PageRecorder({ audit }).record(report(), "   ");
    expect(res.audited).toBe(false);
    expect(res.reason).toContain("blank");
    expect(emitted).toEqual([]);
  });

  it("does not fall back to the resolver on a blank supplied tenant", async () => {
    const { audit, emitted } = fakeAudit();
    // `??` is nullish, not falsy: a blank string is an answer, and a wrong one. Deferring to a
    // resolver here would file the row under whatever the directory guessed instead.
    const res = await new PageRecorder({ audit, tenantIdFor: () => TENANT_B }).record(
      report(),
      "",
    );
    expect(res.audited).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("still keeps the supplied tenant out of the payload", async () => {
    const { audit, emitted } = fakeAudit();
    await new PageRecorder({ audit }).record(report(), TENANT_A);
    expect(JSON.stringify(emitted[0]?.after)).not.toContain(TENANT_A);
  });
});

describe("formatPageRecord", () => {
  it("names the operation and says the page was recorded", () => {
    const line = formatPageRecord(report(), { audited: true, reason: null });
    expect(line).toContain(PAGE_DELIVERED_OPERATION);
    expect(line).toContain(INCIDENT);
    expect(line).toContain("recorded");
  });

  it("says loudly when a page did not become evidence, and why", () => {
    const line = formatPageRecord(report({ outcomes: [outcome({ disposition: "failed" })] }), {
      audited: false,
      reason: "no audit emitter configured",
    });
    expect(line).toContain(PAGE_UNDELIVERED_OPERATION);
    expect(line).toContain("NOT recorded");
    expect(line).toContain("no audit emitter configured");
  });

  it("tolerates a false outcome with no reason", () => {
    expect(formatPageRecord(report(), { audited: false, reason: null })).toContain("unknown");
  });
});
