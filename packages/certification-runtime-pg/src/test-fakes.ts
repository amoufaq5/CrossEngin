import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import {
  evidenceFromAccessReviewEvidence,
  evidenceFromDrReadiness,
  evidenceFromEncryptionCoverage,
  evidenceFromForensicChain,
  type ControlEvidence,
} from "@crossengin/certification-runtime";

export const FIXTURE_TIME = "2026-06-01T00:00:00.000Z";

/** A four-control evidence set that makes SOC 2 / HIPAA fully certifiable. */
export function compliantEvidence(at = FIXTURE_TIME): ControlEvidence[] {
  return [
    evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      {
        framework: "soc2_type2",
        status: "sealed",
        sealedSha256: "b".repeat(64),
        completionRate: 1,
        strongAttestationRate: 1,
        controlMappings: ["CC6.1"],
      },
      at,
    ),
    evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      { schema: "meta", pgcryptoInstalled: true, total: 2, plaintext: 0, issues: [] },
      at,
    ),
    evidenceFromForensicChain(
      "audit.tamper_evident_log",
      { valid: true, brokenAt: null },
      at,
    ),
    evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: true, counts: { totalIssues: 0 } },
      at,
    ),
  ];
}

/**
 * In-memory fake of the platform-wide `meta.certification_reports` table,
 * enough to round-trip the store's INSERT / SELECT paths offline.
 */
export function fakeCertificationPg(): PgConnection {
  const rows = new Map<string, Record<string, unknown>>();

  const run = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult> => {
    const p = params ?? [];
    if (sql.includes("INSERT INTO")) {
      const reportId = String(p[0]);
      if (!rows.has(reportId)) {
        rows.set(reportId, {
          report_id: p[0],
          tenant_id: p[1] ?? null,
          framework: p[2],
          certifiable: p[3],
          controls_total: p[4],
          controls_satisfied: p[5],
          controls_deficient: p[6],
          controls_not_assessed: p[7],
          sealed_sha256: p[8],
          report: p[9],
          generated_at: p[10],
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT")) {
      let visible = [...rows.values()];
      if (sql.includes("WHERE report_id = $1")) {
        visible = visible.filter((r) => r["report_id"] === p[0]);
      } else if (sql.includes("WHERE framework = $1")) {
        visible = visible.filter((r) => r["framework"] === p[0]);
      }
      visible.sort((a, b) =>
        String(b["generated_at"]).localeCompare(String(a["generated_at"])),
      );
      const limitParam = p[p.length - 1];
      const limit =
        typeof limitParam === "number" && sql.includes("LIMIT")
          ? limitParam
          : sql.includes("LIMIT 1")
            ? 1
            : visible.length;
      const sliced = visible.slice(0, limit);
      return { rows: sliced, rowCount: sliced.length };
    }
    return { rows: [], rowCount: 0 };
  };

  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}
