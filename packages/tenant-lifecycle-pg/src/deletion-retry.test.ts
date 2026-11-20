import { ASSEMBLY_REFUSAL_REASONS } from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  PIPELINE_INPUT_REFUSAL_REASONS,
  SCHEMA_ERASER_REFUSAL_REASONS,
} from "./deletion-pipeline.js";
import {
  DELETION_REFUSAL_DISPOSITIONS,
  DELETION_REFUSAL_RETRYABILITY,
  DELETION_REFUSAL_VOCABULARY,
  DEFAULT_DELETION_RETRY_BACKOFF,
  RELEASE_REASONS_RE,
  deletionRefusalDisposition,
  deletionRetryBackoffMs,
  formatRefusalReasons,
} from "./deletion-retry.js";
import { SHARED_TABLE_ERASURE_REFUSAL_REASONS } from "./shared-table-erasure.js";

describe("DELETION_REFUSAL_RETRYABILITY", () => {
  it("is total over each stage's vocabulary, in both directions", () => {
    // The compiler holds the keys to the types; this holds them to the runtime arrays, so a reason
    // added to a vocabulary but typed loosely somewhere still has to be answered here.
    const sorted = (xs: readonly string[]): string[] => [...xs].sort();
    expect(sorted(Object.keys(DELETION_REFUSAL_RETRYABILITY.input))).toEqual(
      sorted(PIPELINE_INPUT_REFUSAL_REASONS),
    );
    expect(sorted(Object.keys(DELETION_REFUSAL_RETRYABILITY.erase))).toEqual(
      sorted([...new Set([...SHARED_TABLE_ERASURE_REFUSAL_REASONS, ...SCHEMA_ERASER_REFUSAL_REASONS])]),
    );
    expect(sorted(Object.keys(DELETION_REFUSAL_RETRYABILITY.assemble))).toEqual(
      sorted(ASSEMBLY_REFUSAL_REASONS),
    );
    for (const stage of ["input", "erase", "assemble"] as const) {
      expect(sorted(Object.keys(DELETION_REFUSAL_RETRYABILITY[stage]))).toEqual(
        sorted(DELETION_REFUSAL_VOCABULARY[stage]),
      );
      for (const d of Object.values(DELETION_REFUSAL_RETRYABILITY[stage])) {
        expect(DELETION_REFUSAL_DISPOSITIONS).toContain(d);
      }
    }
  });

  it("answers retry for the confined role, which is the case the map exists for", () => {
    expect(DELETION_REFUSAL_RETRYABILITY.erase.rls_would_confine_this_session).toBe("retry");
  });

  it("answers final for the causes ADR-0446 named as the request's own", () => {
    // An empty tenant and a caller's body mistake would refuse identically whatever the deployment
    // did, so releasing them would only delay the answer the data subject is owed.
    expect(DELETION_REFUSAL_RETRYABILITY.assemble.scope_empty).toBe("final");
    expect(DELETION_REFUSAL_RETRYABILITY.input.performed_subsystem_attested).toBe("final");
    expect(DELETION_REFUSAL_RETRYABILITY.erase.four_eyes_violated).toBe("final");
    expect(DELETION_REFUSAL_RETRYABILITY.assemble.four_eyes_violated).toBe("final");
  });

  it("answers final for every reason raised after the first destructive statement", () => {
    // The schema eraser runs after the shared erasure has deleted, and assembly after both, so a
    // retry of any of these would repeat a full erasure and its rollback on every runner tick. The
    // type already pins them to "final"; this holds the runtime object to it as well.
    for (const reason of SCHEMA_ERASER_REFUSAL_REASONS) {
      expect(DELETION_REFUSAL_RETRYABILITY.erase[reason]).toBe("final");
    }
    for (const reason of ASSEMBLY_REFUSAL_REASONS) {
      expect(DELETION_REFUSAL_RETRYABILITY.assemble[reason]).toBe("final");
    }
    // The two the first draft released, named: one is an operator's collateral, the other a static
    // capability declaration that refused every runner attempt identically.
    expect(DELETION_REFUSAL_RETRYABILITY.erase.external_dependents).toBe("final");
    expect(DELETION_REFUSAL_RETRYABILITY.assemble.subsystem_unattested).toBe("final");
    expect(
      deletionRefusalDisposition([{ stage: "assemble", reason: "subsystem_unattested" }]),
    ).toBe("final");
  });

  it("releases only reasons the shared erasure or the input stage establish before writing", () => {
    const retryable = (["input", "erase", "assemble"] as const).flatMap((stage) =>
      Object.entries(DELETION_REFUSAL_RETRYABILITY[stage])
        .filter(([, d]) => d === "retry")
        .map(([reason]) => `${stage}/${reason}`),
    );
    const preWrite = new Set([
      ...PIPELINE_INPUT_REFUSAL_REASONS.map((r) => `input/${r}`),
      ...SHARED_TABLE_ERASURE_REFUSAL_REASONS.map((r) => `erase/${r}`),
    ]);
    expect(retryable.length).toBeGreaterThan(0);
    for (const key of retryable) expect(preWrite.has(key)).toBe(true);
  });

  it("has both dispositions in use, so neither half is a dead branch", () => {
    const all = (["input", "erase", "assemble"] as const).flatMap((s) =>
      Object.values(DELETION_REFUSAL_RETRYABILITY[s]),
    );
    expect(new Set(all)).toEqual(new Set(DELETION_REFUSAL_DISPOSITIONS));
  });
});

describe("deletionRefusalDisposition", () => {
  it("retries only when every refusal is retryable", () => {
    expect(
      deletionRefusalDisposition([
        { stage: "erase", reason: "rls_would_confine_this_session" },
        { stage: "erase", reason: "table_missing" },
      ]),
    ).toBe("retry");
    expect(
      deletionRefusalDisposition([
        { stage: "erase", reason: "rls_would_confine_this_session" },
        { stage: "assemble", reason: "scope_empty" },
      ]),
    ).toBe("final");
  });

  it("is final for an empty list, an unknown stage, an unknown reason and a prototype name", () => {
    // `final` is the behaviour before ADR-0453, so a refusal nobody can classify keeps it rather
    // than holding the tenant in pending_deletion on a guess.
    expect(deletionRefusalDisposition([])).toBe("final");
    expect(deletionRefusalDisposition([{ stage: "store", reason: "table_missing" }])).toBe("final");
    expect(deletionRefusalDisposition([{ stage: "erase", reason: "not_a_reason" }])).toBe("final");
    expect(deletionRefusalDisposition([{ stage: "erase", reason: "constructor" }])).toBe("final");
    expect(deletionRefusalDisposition([{ stage: "erase", reason: "toString" }])).toBe("final");
  });

  it("keys the reason by its stage, so one name under two stages is two answers", () => {
    // `table_missing` is an erase reason; under `assemble` it is unknown, and unknown is final.
    expect(deletionRefusalDisposition([{ stage: "erase", reason: "table_missing" }])).toBe("retry");
    expect(deletionRefusalDisposition([{ stage: "assemble", reason: "table_missing" }])).toBe("final");
  });
});

describe("formatRefusalReasons", () => {
  it("is one stage/reason line, bounded to 500 characters", () => {
    expect(
      formatRefusalReasons([
        { stage: "erase", reason: "rls_would_confine_this_session" },
        { stage: "erase", reason: "table_missing" },
      ]),
    ).toBe("erase/rls_would_confine_this_session; erase/table_missing");
    // Duplicates collapse, and a long list is cut on a whole code, never mid-code.
    expect(
      formatRefusalReasons(
        Array.from({ length: 100 }, () => ({ stage: "erase", reason: "rls_would_confine_this_session" })),
      ),
    ).toBe("erase/rls_would_confine_this_session");
    const long = formatRefusalReasons(
      Array.from({ length: 100 }, (_, i) => ({ stage: "erase", reason: `reason_${"x".repeat(i % 26)}` })),
    );
    expect(long.length).toBeLessThanOrEqual(500);
    expect(long).toMatch(RELEASE_REASONS_RE);
  });

  it("writes only vocabulary codes for every release it can produce (ADR-0458)", () => {
    // A release happens only when every refusal is `retry`, so these are exactly the lines a
    // `last_attempt_refusal` can hold — and the read routes surface it because they carry no tenant
    // id, table name or count. All of them at once is the longest such line.
    const retry = Object.entries(DELETION_REFUSAL_RETRYABILITY).flatMap(([stage, map]) =>
      Object.entries(map as Record<string, string>)
        .filter(([, d]) => d === "retry")
        .map(([reason]) => ({ stage, reason })),
    );
    expect(retry.length).toBeGreaterThan(10);
    for (const one of retry) expect(formatRefusalReasons([one])).toMatch(RELEASE_REASONS_RE);
    expect(formatRefusalReasons(retry)).toMatch(RELEASE_REASONS_RE);
    expect("erase/table_missing; meta.orders").not.toMatch(RELEASE_REASONS_RE);
    expect("erase/rls 0f8e3c2a-…").not.toMatch(RELEASE_REASONS_RE);
  });

  it("never answers the empty string, which the column's CHECK refuses", () => {
    expect(formatRefusalReasons([])).toBe("unclassified refusal");
  });
});

describe("deletionRetryBackoffMs (ADR-0458)", () => {
  it("doubles from the base and stops at the cap", () => {
    const at = [1, 2, 3, 4, 6, 7, 8, 50].map((n) => deletionRetryBackoffMs(n));
    expect(at).toEqual([60_000, 120_000, 240_000, 480_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000]);
    expect(DEFAULT_DELETION_RETRY_BACKOFF).toEqual({ baseMs: 60_000, capMs: 3_600_000 });
  });

  it("does not overflow however long a request stays stuck", () => {
    expect(deletionRetryBackoffMs(10_000, { baseMs: 1, capMs: 5 })).toBe(5);
    expect(Number.isFinite(deletionRetryBackoffMs(1_000_000))).toBe(true);
  });

  it("refuses a count that is not a positive integer, and an inverted policy", () => {
    expect(() => deletionRetryBackoffMs(0)).toThrow(/positive integer/);
    expect(() => deletionRetryBackoffMs(1.5)).toThrow(/positive integer/);
    expect(() => deletionRetryBackoffMs(1, { baseMs: 10, capMs: 5 })).toThrow(/baseMs <= capMs/);
    expect(() => deletionRetryBackoffMs(1, { baseMs: -1, capMs: 5 })).toThrow(/baseMs <= capMs/);
  });
});
