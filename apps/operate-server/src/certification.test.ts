import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import {
  FixedClock,
  RandomIdGenerator,
  evidenceFromEncryptionCoverage,
  type CertificationReport,
  type ComplianceFramework,
  type ControlEvidence,
} from "@crossengin/certification-runtime";
import type { IntervalScheduler } from "./jwks.js";

import {
  CertificationScheduler,
  accessReviewSource,
  buildCertificationLifecycle,
  drReadinessSource,
  encryptionCoverageSource,
  loadCertificationConfig,
  parseCertificationConfig,
  type EvidenceSource,
} from "./certification.js";

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
    const src = drReadinessSource({ latest: async () => null });
    expect(await src.collect("soc2_type2", AT)).toEqual([]);
  });

  it("drReadinessSource maps the latest snapshot", async () => {
    const src = drReadinessSource({
      latest: async () => ({ report: { ready: true, counts: { totalIssues: 0 } } }),
    });
    const [ev] = await src.collect("soc2_type2", AT);
    expect(ev?.sourceKind).toBe("dr_readiness");
    expect(ev?.satisfied).toBe(true);
  });

  it("accessReviewSource is framework-aware and skips a missing pack", async () => {
    const reader = {
      latestSealed: async (fw: ComplianceFramework) =>
        fw === "soc2_type2"
          ? {
              framework: fw,
              status: "sealed",
              sealedSha256: "a".repeat(64),
              completionRate: 1,
              strongAttestationRate: 1,
              controlMappings: ["CC6.1"],
            }
          : null,
    };
    const src = accessReviewSource(reader);
    expect((await src.collect("soc2_type2", AT))[0]?.satisfied).toBe(true);
    expect(await src.collect("hipaa_security_rule", AT)).toEqual([]);
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
    const drSource = drReadinessSource({
      latest: async () => ({ report: { ready: true, counts: { totalIssues: 0 } } }),
    });
    const arSource = accessReviewSource({
      latestSealed: async (fw) => ({
        framework: fw,
        status: "sealed",
        sealedSha256: "c".repeat(64),
        completionRate: 1,
        strongAttestationRate: 1,
        controlMappings: ["X"],
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
