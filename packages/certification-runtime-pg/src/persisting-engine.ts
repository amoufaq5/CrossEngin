import type { PgConnection } from "@crossengin/kernel-pg";
import {
  CertificationEngine,
  type CertificationEngineOptions,
  type CertificationReport,
  type ComplianceFramework,
  type ControlEvidence,
} from "@crossengin/certification-runtime";
import { PostgresCertificationReportStore } from "./report-store.js";
import { certificationReportRecordFrom } from "./records.js";

export interface PersistentCertificationEngine {
  readonly engine: CertificationEngine;
  readonly store: PostgresCertificationReportStore;
  certify(
    framework: ComplianceFramework,
    evidence: readonly ControlEvidence[],
  ): Promise<CertificationReport>;
  certifyAll(
    frameworks: readonly ComplianceFramework[],
    evidence: readonly ControlEvidence[],
  ): Promise<CertificationReport[]>;
}

export function buildPersistentCertificationEngine(
  conn: PgConnection,
  options: CertificationEngineOptions = {},
): PersistentCertificationEngine {
  const engine = new CertificationEngine(options);
  const store = new PostgresCertificationReportStore(conn);

  async function certify(
    framework: ComplianceFramework,
    evidence: readonly ControlEvidence[],
  ): Promise<CertificationReport> {
    const report = engine.certify(framework, evidence);
    await store.record(certificationReportRecordFrom(report));
    return report;
  }

  async function certifyAll(
    frameworks: readonly ComplianceFramework[],
    evidence: readonly ControlEvidence[],
  ): Promise<CertificationReport[]> {
    const reports: CertificationReport[] = [];
    for (const framework of frameworks) {
      reports.push(await certify(framework, evidence));
    }
    return reports;
  }

  return { engine, store, certify, certifyAll };
}
