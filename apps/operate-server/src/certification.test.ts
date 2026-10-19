import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { verifyChainIntegrity } from "@crossengin/forensics";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import {
  FixedClock,
  RandomIdGenerator,
  type CertificationReport,
  type ComplianceFramework,
  type ControlEvidence,
} from "@crossengin/certification-runtime";
import type { IntervalScheduler } from "./jwks.js";

import {
  CertificationScheduler,
  PostgresAccessReviewEvidenceReader,
  accessReviewSource,
  AccessReviewEvidenceUnavailableError,
  type AccessReviewEvidenceLookup,
  buildCertificationLifecycle,
  drReadinessSource,
  encryptionCoverageSource,
  forensicChainSource,
  loadCertificationConfig,
  parseCertificationConfig,
  type EvidenceSource,
} from "./certification.js";

const G = "0".repeat(64);
function chainEntry(seq: number, prior: string, hash: string) {
  return {
    sequenceNumber: seq,
    kind: "audit_event" as const,
    recordedAt: AT,
    actorReference: "svc",
    payloadSha256: "d".repeat(64),
    payloadSizeBytes: 10,
    priorEntryHash: prior,
    entryHash: hash,
    signingKeyFingerprint: "e".repeat(64),
    signature: "sig",
  };
}

const AT = "2026-06-01T00:00:00.000Z";
const TENANT = "11111111-1111-1111-1111-111111111111";

/** Captures INSERTs into meta.certification_reports (platform-wide, no round-trip needed for these tests). */
function fakeConn(captured: { sql: string; params: readonly unknown[] | undefined }[]): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 0 } as PgQueryResult;
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => {}) as PgConnection["close"],
  };
  return conn;
}

/** A source that always yields a satisfied encryption-coverage evidence for the given controls. */
function satisfiedEncryptionSource(): EvidenceSource {
  return encryptionCoverageSource(
    {
      coverage: async () => ({
        schema: "meta",
        pgcryptoInstalled: true,
        total: 2,
        plaintext: 0,
        issues: [],
      }),
    },
    "meta",
  );
}

describe("parseCertificationConfig", () => {
  it("applies defaults for an empty input", () => {
    const c = parseCertificationConfig({});
    expect(c.tenantId).toBeNull();
    expect(c.intervalMs).toBe(86_400_000);
    expect(c.schema).toBe("meta");
    expect(c.frameworks).toEqual(["soc2_type2", "hipaa_security_rule"]);
    expect(c.drReadiness).toBe(true);
    expect(c.accessReviews).toBe(true);
    expect(c.forensicChain).toBe(true);
  });

  it("accepts explicit frameworks + toggles", () => {
    const c = parseCertificationConfig({
      tenantId: TENANT,
      intervalMs: 60_000,
      frameworks: ["pci_dss_v4"],
      drReadiness: false,
      accessReviews: false,
    });
    expect(c.tenantId).toBe(TENANT);
    expect(c.frameworks).toEqual(["pci_dss_v4"]);
    expect(c.drReadiness).toBe(false);
  });

  it("rejects an empty frameworks array, unknown framework, and unknown key", () => {
    expect(() => parseCertificationConfig({ frameworks: [] })).toThrow();
    expect(() => parseCertificationConfig({ frameworks: ["nope"] })).toThrow();
    expect(() => parseCertificationConfig({ bogus: 1 })).toThrow();
    expect(() => parseCertificationConfig({ schema: "Bad-Schema" })).toThrow();
  });
});

describe("loadCertificationConfig", () => {
  it("reads + validates a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cert-cfg-"));
    const path = join(dir, "cert.json");
    await writeFile(path, JSON.stringify({ frameworks: ["soc2_type2"] }), "utf8");
    const c = await loadCertificationConfig(path);
    expect(c.frameworks).toEqual(["soc2_type2"]);
  });

  it("wraps a missing file", async () => {
    await expect(loadCertificationConfig("/no/such/cert.json")).rejects.toThrow(
      /--certification-config: cannot read/,
    );
  });
});

describe("evidence sources", () => {
  it("encryptionCoverageSource maps a satisfied coverage report", async () => {
    const [ev] = await satisfiedEncryptionSource().collect("soc2_type2", AT);
    expect(ev?.sourceKind).toBe("encryption_coverage");
    expect(ev?.satisfied).toBe(true);
  });

  it("drReadinessSource yields nothing when no snapshot exists", async () => {
    const src = drReadinessSource({ latest: async () => null }, null);
    expect(await src.collect("soc2_type2", AT)).toEqual([]);
  });

  it("drReadinessSource maps the latest snapshot", async () => {
    const src = drReadinessSource(
      {
        latest: async () => ({
          report: {
            ready: true,
            counts: { totalIssues: 0 },
            // Both axis lists are `[]` rather than omitted, for the reason the fields are required:
            // an absent one would certify this control by omission (ADR-0372, ADR-0373).
            unevidencedAxes: [],
            unreadableEvidenceAxes: [],
          },
        }),
      },
      null,
    );
    const [ev] = await src.collect("soc2_type2", AT);
    expect(ev?.sourceKind).toBe("dr_readiness");
    expect(ev?.satisfied).toBe(true);
  });

  it("forensicChainSource yields nothing for an empty chain (not a vacuous pass)", async () => {
    const src = forensicChainSource({ loadChain: async () => ({ entries: [], unreadable: [] }) });
    expect(await src.collect("soc2_type2", AT)).toEqual([]);
  });

  it("forensicChainSource reports a chain whose every row is refused, where an empty chain yields nothing", async () => {
    const refused = forensicChainSource({
      loadChain: async () => ({
        entries: [],
        unreadable: [{ identity: "0", detail: "kind: invalid_enum_value" }],
      }),
    });
    const items = await refused.collect("soc2_type2", AT);
    expect(items).toHaveLength(1);
    expect(items[0]?.sourceKind).toBe("forensic_chain");
    expect(items[0]?.satisfied).toBe(false);
    expect(items[0]?.findings[0]).toContain("the contract refuses");

    const empty = forensicChainSource({ loadChain: async () => ({ entries: [], unreadable: [] }) });
    expect(await empty.collect("soc2_type2", AT)).toEqual([]);
  });

  it("forensicChainSource verifies an intact chain from genesis", async () => {
    const h1 = "1".repeat(64);
    const h2 = "2".repeat(64);
    const src = forensicChainSource({
      loadChain: async () => ({
        entries: [chainEntry(0, G, h1), chainEntry(1, h1, h2)],
        unreadable: [],
      }),
    });
    const [ev] = await src.collect("soc2_type2", AT);
    expect(ev?.sourceKind).toBe("forensic_chain");
    expect(ev?.satisfied).toBe(true);
  });

  it("forensicChainSource flags a broken chain", async () => {
    const h1 = "1".repeat(64);
    const h2 = "2".repeat(64);
    const src = forensicChainSource({
      // entry 1 claims a wrong priorEntryHash → chain broken at 1
      loadChain: async () => ({
        entries: [chainEntry(0, G, h1), chainEntry(1, "9".repeat(64), h2)],
        unreadable: [],
      }),
    });
    const [ev] = await src.collect("soc2_type2", AT);
    expect(ev?.satisfied).toBe(false);
    expect(ev?.findings[0]).toContain("1");
  });

  it("forensicChainSource takes the refused row over a fold that would have passed", async () => {
    const h1 = "1".repeat(64);
    const h2 = "2".repeat(64);
    const entries = [chainEntry(0, G, h1), chainEntry(1, h1, h2)];
    // The fold's own answer over these same entries, so the verdict below is the refused row's.
    expect(verifyChainIntegrity(entries).valid).toBe(true);

    const src = forensicChainSource({
      loadChain: async () => ({
        entries,
        unreadable: [{ identity: "2", detail: "kind: invalid_enum_value" }],
      }),
    });
    const [ev] = await src.collect("soc2_type2", AT);
    expect(ev?.satisfied).toBe(false);
    expect(ev?.findings[0]).toBe(
      "chain broken at sequence 2: 1 entry the contract refuses (first: kind: invalid_enum_value)",
    );
    expect(ev?.findings[0]).not.toContain("sequence gap");
  });

  it("accessReviewSource is framework-aware and skips a missing pack", async () => {
    const reader = {
      latestSealed: async (fw: ComplianceFramework): Promise<AccessReviewEvidenceLookup> =>
        fw === "soc2_type2"
          ? {
              kind: "evidence",
              evidence: {
                framework: fw,
                status: "sealed",
                sealedSha256: "a".repeat(64),
                // Non-zero on purpose: this fixture's subject is a SATISFIED control, and `0` now
                // reads as `scope_absent` — a pack that sealed over nothing reviewed.
                totalItemsAcrossCampaigns: 12,
                completionRate: 1,
                strongAttestationRate: 1,
                controlMappings: ["CC6.1"],
              },
            }
          : { kind: "none" },
    };
    const src = accessReviewSource(reader);
    expect((await src.collect("soc2_type2", AT))[0]?.satisfied).toBe(true);
    expect(await src.collect("hipaa_security_rule", AT)).toEqual([]);
  });

  it("accessReviewSource throws on `unscoped`, so `could not look` is not `found none`", async () => {
    const src = accessReviewSource({
      latestSealed: async (): Promise<AccessReviewEvidenceLookup> => ({
        kind: "unscoped",
        detail: "this certification names no tenant",
      }),
    });
    await expect(src.collect("soc2_type2", AT)).rejects.toBeInstanceOf(
      AccessReviewEvidenceUnavailableError,
    );
  });

  it("the unavailable error names the control's consequence, not just the cause", async () => {
    const err = new AccessReviewEvidenceUnavailableError("iso27001", "no tenant");
    expect(err.message).toContain("iso27001");
    expect(err.message).toContain("not_assessed");
    expect(err.message).toContain("cannot be certifiable");
  });

  it("an `unscoped` source leaves the control not_assessed rather than deficient", async () => {
    const captured: { sql: string; params: readonly unknown[] | undefined }[] = [];
    const errors: unknown[] = [];
    const lc = buildCertificationLifecycle(
      fakeConn(captured),
      parseCertificationConfig({ tenantId: TENANT, frameworks: ["soc2_type2"] }),
      {
        sources: [
          satisfiedEncryptionSource(),
          accessReviewSource({
            latestSealed: async (): Promise<AccessReviewEvidenceLookup> => ({
              kind: "unscoped",
              detail: "no tenant",
            }),
          }),
        ],
        clock: new FixedClock(new Date(AT)),
        ids: new RandomIdGenerator(),
        now: () => new Date(AT),
        onSourceError: (e) => errors.push(e),
      },
    );
    const [report] = await lc.certifyOnce();
    const control = report?.assessment.controls.find(
      (c) => c.controlId === "access.periodic_review",
    );
    expect(control?.status).toBe("not_assessed");
    expect(report?.certifiable).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AccessReviewEvidenceUnavailableError);
  });
});

describe("PostgresAccessReviewEvidenceReader", () => {
  function recordingConn(
    rows: Record<string, unknown>[],
    captured: { sql: string; params: readonly unknown[] | undefined }[],
  ): PgConnection {
    const conn: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]) => {
        captured.push({ sql, params });
        if (sql.includes("access_review_evidence")) {
          return { rows, rowCount: rows.length } as PgQueryResult;
        }
        return { rows: [], rowCount: 0 } as PgQueryResult;
      }) as PgConnection["query"],
      transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
      withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => {}) as PgConnection["close"],
    };
    return conn;
  }

  const sealedRow = {
    framework: "soc2_type2",
    status: "sealed",
    sealed_sha256: "f".repeat(64),
    // INTEGER arrives as a number; non-zero, because 0 is what makes the control `scope_absent`
    // (ADR-0372) and these tests' subject is the rate parsing rather than the scope guard.
    total_items_across_campaigns: 12,
    // NUMERIC arrives as a string from node-postgres, which is what the live row looks like.
    completion_rate: "0.8333",
    strong_attestation_rate: "0.5000",
    control_mappings: ["CC6.1"],
  };

  it("answers `unscoped` for a null tenant rather than `none`", async () => {
    const captured: { sql: string; params: readonly unknown[] | undefined }[] = [];
    const reader = new PostgresAccessReviewEvidenceReader(recordingConn([], captured), null);
    const lookup = await reader.latestSealed("soc2_type2");
    expect(lookup.kind).toBe("unscoped");
    expect(captured).toHaveLength(0);
  });

  it("the unscoped detail names both remedies", async () => {
    const reader = new PostgresAccessReviewEvidenceReader(recordingConn([], []), null);
    const lookup = await reader.latestSealed("soc2_type2");
    if (lookup.kind !== "unscoped") throw new Error("expected unscoped");
    expect(lookup.detail).toContain("tenantId");
    expect(lookup.detail).toContain("accessReviews:false");
  });

  it("carries a strict tenant_id predicate beside RLS", async () => {
    const captured: { sql: string; params: readonly unknown[] | undefined }[] = [];
    const reader = new PostgresAccessReviewEvidenceReader(recordingConn([], captured), TENANT);
    await reader.latestSealed("soc2_type2");
    const select = captured.find((c) => c.sql.includes("FROM meta.access_review_evidence"));
    expect(select?.sql).toContain("tenant_id = $2");
    expect(select?.sql).not.toContain("tenant_id IS NULL");
    expect(select?.params).toEqual(["soc2_type2", TENANT]);
  });

  it("sets the tenant RLS context before reading", async () => {
    const captured: { sql: string; params: readonly unknown[] | undefined }[] = [];
    const reader = new PostgresAccessReviewEvidenceReader(recordingConn([], captured), TENANT);
    await reader.latestSealed("soc2_type2");
    expect(captured[0]?.sql).toContain("set_config('app.current_tenant_id'");
    expect(captured[0]?.params).toEqual([TENANT]);
  });

  it("filters to the three statuses the assessor treats as sealed", async () => {
    const captured: { sql: string; params: readonly unknown[] | undefined }[] = [];
    const reader = new PostgresAccessReviewEvidenceReader(recordingConn([], captured), TENANT);
    await reader.latestSealed("soc2_type2");
    const select = captured.find((c) => c.sql.includes("FROM meta.access_review_evidence"));
    expect(select?.sql).toContain("status IN ('sealed', 'submitted_to_auditor', 'accepted_by_auditor')");
  });

  it("orders totally, so two packs sharing a period end cannot flip", async () => {
    const captured: { sql: string; params: readonly unknown[] | undefined }[] = [];
    const reader = new PostgresAccessReviewEvidenceReader(recordingConn([], captured), TENANT);
    await reader.latestSealed("soc2_type2");
    const select = captured.find((c) => c.sql.includes("FROM meta.access_review_evidence"));
    expect(select?.sql).toContain("ORDER BY period_end_at DESC, evidence_id DESC");
  });

  it("answers `none` when the scope holds no sealed pack", async () => {
    const reader = new PostgresAccessReviewEvidenceReader(recordingConn([], []), TENANT);
    expect((await reader.latestSealed("soc2_type2")).kind).toBe("none");
  });

  it("parses a NUMERIC rate arriving as a string", async () => {
    const reader = new PostgresAccessReviewEvidenceReader(recordingConn([sealedRow], []), TENANT);
    const lookup = await reader.latestSealed("soc2_type2");
    if (lookup.kind !== "evidence") throw new Error("expected evidence");
    expect(lookup.evidence.completionRate).toBeCloseTo(0.8333, 6);
    expect(lookup.evidence.strongAttestationRate).toBeCloseTo(0.5, 6);
    expect(lookup.evidence.sealedSha256).toBe("f".repeat(64));
  });

  it("refuses an unreadable rate rather than reporting it as 0%", async () => {
    const reader = new PostgresAccessReviewEvidenceReader(
      recordingConn([{ ...sealedRow, completion_rate: null }], []),
      TENANT,
    );
    await expect(reader.latestSealed("soc2_type2")).rejects.toThrow(/completion_rate/);
  });

  it("refuses an unreadable item count rather than reporting it as an empty scope", async () => {
    // `0` is the value that makes this control `scope_absent` (ADR-0372), so defaulting an
    // unreadable column to it would assert the finding instead of reporting that nothing could be
    // read — the same hole `requireRate`'s own comment records for `?? 0`, one column across.
    const reader = new PostgresAccessReviewEvidenceReader(
      recordingConn([{ ...sealedRow, total_items_across_campaigns: null }], []),
      TENANT,
    );
    await expect(reader.latestSealed("soc2_type2")).rejects.toThrow(
      /total_items_across_campaigns/,
    );
  });

  it("rejects a schema identifier that is not a bare identifier", () => {
    expect(
      () => new PostgresAccessReviewEvidenceReader(recordingConn([], []), TENANT, "me ta"),
    ).toThrow(/invalid schema identifier/);
  });
});

describe("CertificationScheduler", () => {
  function manualScheduler(): { scheduler: IntervalScheduler; fire: () => void } {
    let handler: (() => void) | null = null;
    return {
      scheduler: {
        setInterval: (h) => {
          handler = h;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => {
          handler = null;
        },
      },
      fire: () => handler?.(),
    };
  }

  it("runs immediately on start then on each interval; stop clears it", async () => {
    const { scheduler, fire } = manualScheduler();
    const certify = vi.fn(async () => [] as CertificationReport[]);
    const s = new CertificationScheduler({ certify, intervalMs: 1000, scheduler });
    s.start();
    await Promise.resolve();
    expect(certify).toHaveBeenCalledTimes(1);
    fire();
    await Promise.resolve();
    expect(certify).toHaveBeenCalledTimes(2);
    s.stop();
    fire();
    expect(certify).toHaveBeenCalledTimes(2);
  });

  it("routes a certify error to onError", async () => {
    const onError = vi.fn();
    const s = new CertificationScheduler({
      certify: async () => {
        throw new Error("boom");
      },
      intervalMs: 1000,
      scheduler: { setInterval: () => 1 as never, clearInterval: () => undefined },
      onError,
    });
    s.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("buildCertificationLifecycle", () => {
  function fixtures() {
    return {
      clock: new FixedClock(new Date(AT)),
      ids: new RandomIdGenerator(),
      now: () => new Date(AT),
    };
  }

  it("certifies + persists one sealed report per framework", async () => {
    const captured: { sql: string; params: readonly unknown[] | undefined }[] = [];
    const conn = fakeConn(captured);
    const drSource = drReadinessSource(
      {
        latest: async () => ({
          report: {
            ready: true,
            counts: { totalIssues: 0 },
            // Both axis lists are `[]` rather than omitted, for the reason the fields are required:
            // an absent one would certify this control by omission (ADR-0372, ADR-0373).
            unevidencedAxes: [],
            unreadableEvidenceAxes: [],
          },
        }),
      },
      null,
    );
    const arSource = accessReviewSource({
      latestSealed: async (fw) => ({
        kind: "evidence",
        evidence: {
          framework: fw,
          status: "sealed",
          sealedSha256: "c".repeat(64),
          // Non-zero: this lifecycle test asserts a sealed, certifiable report per framework.
          totalItemsAcrossCampaigns: 12,
          completionRate: 1,
          strongAttestationRate: 1,
          controlMappings: ["X"],
        },
      }),
    });
    const forensicSource: EvidenceSource = {
      collect: async () => [
        {
          controlId: "audit.tamper_evident_log",
          sourceKind: "forensic_chain",
          satisfied: true,
          summary: "chain ok",
          findings: [],
          observedAt: AT,
          detailRef: null,
        } as ControlEvidence,
      ],
    };

    const lc = buildCertificationLifecycle(
      conn,
      parseCertificationConfig({ tenantId: TENANT, frameworks: ["soc2_type2", "hipaa_security_rule"] }),
      { sources: [satisfiedEncryptionSource(), drSource, arSource, forensicSource], ...fixtures() },
    );
    const reports = await lc.certifyOnce();

    expect(reports.map((r) => r.framework)).toEqual(["soc2_type2", "hipaa_security_rule"]);
    expect(reports.every((r) => r.certifiable)).toBe(true);
    const inserts = captured.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts).toHaveLength(2);
  });

  it("a missing evidence source leaves a control not_assessed → not certifiable", async () => {
    const conn = fakeConn([]);
    const lc = buildCertificationLifecycle(
      conn,
      parseCertificationConfig({ tenantId: TENANT, frameworks: ["soc2_type2"] }),
      { sources: [satisfiedEncryptionSource()], ...fixtures() },
    );
    const [report] = await lc.certifyOnce();
    expect(report?.certifiable).toBe(false);
    expect(report?.assessment.counts.notAssessed).toBeGreaterThan(0);
  });

  it("a throwing source is best-effort — routed to onSourceError, others still collected", async () => {
    const onSourceError = vi.fn();
    const badSource: EvidenceSource = {
      collect: async () => {
        throw new Error("source down");
      },
    };
    const lc = buildCertificationLifecycle(
      fakeConn([]),
      parseCertificationConfig({ tenantId: TENANT, frameworks: ["soc2_type2"] }),
      { sources: [satisfiedEncryptionSource(), badSource], onSourceError, ...fixtures() },
    );
    const [report] = await lc.certifyOnce();
    expect(onSourceError).toHaveBeenCalled();
    // encryption evidence still landed, so that control is satisfied (not not_assessed)
    const enc = report?.assessment.controls.find((c) => c.controlId === "data.encryption_at_rest");
    expect(enc?.status).toBe("satisfied");
  });
});
