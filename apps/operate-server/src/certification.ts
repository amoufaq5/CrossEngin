import { readFile } from "node:fs/promises";

import { z } from "zod";
import {
  COMPLIANCE_FRAMEWORKS,
  evidenceFromAccessReviewEvidence,
  evidenceFromDrReadiness,
  evidenceFromEncryptionCoverage,
  type AccessReviewEvidenceLike,
  type CertificationReport,
  type Clock,
  type ComplianceFramework,
  type ControlEvidence,
  type DrReadinessLike,
  type IdGenerator,
} from "@crossengin/certification-runtime";
import { buildPersistentCertificationEngine } from "@crossengin/certification-runtime-pg";
import { EncryptionApplier, type PgConnection } from "@crossengin/kernel-pg";
import { PostgresDrReadinessStore } from "@crossengin/dr-runtime-pg";
import { withTenantContext } from "@crossengin/access-reviews-runtime-pg";

import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export const CertificationConfigSchema = z
  .object({
    tenantId: z.string().uuid().nullable().default(null),
    intervalMs: z.number().int().positive().default(86_400_000),
    schema: z.string().regex(SCHEMA_RE).default("meta"),
    frameworks: z
      .array(z.enum(COMPLIANCE_FRAMEWORKS))
      .min(1)
      .default(["soc2_type2", "hipaa_security_rule"]),
    drReadiness: z.boolean().default(true),
    accessReviews: z.boolean().default(true),
  })
  .strict();
export type CertificationConfig = z.infer<typeof CertificationConfigSchema>;

export function parseCertificationConfig(json: unknown): CertificationConfig {
  return CertificationConfigSchema.parse(json);
}

export async function loadCertificationConfig(
  path: string,
): Promise<CertificationConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--certification-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--certification-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return parseCertificationConfig(parsed);
}

/**
 * A pluggable evidence source. Each source is framework-aware (access-review evidence is per-framework;
 * encryption / DR evidence is framework-agnostic and simply ignores the argument) and best-effort —
 * a source that yields nothing leaves its control `not_assessed`, so the certification stays fail-closed.
 */
export interface EvidenceSource {
  collect(
    framework: ComplianceFramework,
    at: string,
  ): Promise<readonly ControlEvidence[]>;
}

export interface EncryptionCoverageProvider {
  coverage(schema: string): Promise<{
    readonly schema: string;
    readonly pgcryptoInstalled: boolean;
    readonly total: number;
    readonly plaintext: number;
    readonly issues: readonly { readonly kind: string; readonly detail: string }[];
  }>;
}

/** Live encryption-at-rest coverage over the catalog — the one always-available source (no tenant context). */
export function encryptionCoverageSource(
  provider: EncryptionCoverageProvider,
  schema: string,
  controlId = "data.encryption_at_rest",
): EvidenceSource {
  return {
    async collect(_framework, at) {
      const report = await provider.coverage(schema);
      return [evidenceFromEncryptionCoverage(controlId, report, at)];
    },
  };
}

export interface DrReadinessSnapshotProvider {
  latest(): Promise<{ readonly report: DrReadinessLike } | null>;
}

/** The most recent persisted DR-readiness snapshot (the dr-readiness lifecycle is the producer). */
export function drReadinessSource(
  provider: DrReadinessSnapshotProvider,
  controlId = "resilience.dr_readiness",
): EvidenceSource {
  return {
    async collect(_framework, at) {
      const latest = await provider.latest();
      if (latest === null) return [];
      return [evidenceFromDrReadiness(controlId, latest.report, at)];
    },
  };
}

export interface AccessReviewEvidenceReader {
  latestSealed(
    framework: ComplianceFramework,
  ): Promise<AccessReviewEvidenceLike | null>;
}

/** The latest sealed access-review evidence pack for the framework (per-framework, tenant-scoped). */
export function accessReviewSource(
  reader: AccessReviewEvidenceReader,
  controlId = "access.periodic_review",
): EvidenceSource {
  return {
    async collect(framework, at) {
      const evidence = await reader.latestSealed(framework);
      if (evidence === null) return [];
      return [evidenceFromAccessReviewEvidence(controlId, evidence, at)];
    },
  };
}

/**
 * Reads the latest `access_review_evidence` row for a framework within the tenant's RLS context. Only
 * meaningful for a tenant-scoped certification (the evidence table is tenant-isolated); a null tenant
 * yields no rows.
 */
export class PostgresAccessReviewEvidenceReader
  implements AccessReviewEvidenceReader
{
  private readonly schema: string;

  constructor(
    private readonly conn: PgConnection,
    private readonly tenantId: string | null,
    schema = "meta",
  ) {
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.schema = schema;
  }

  async latestSealed(
    framework: ComplianceFramework,
  ): Promise<AccessReviewEvidenceLike | null> {
    if (this.tenantId === null) return null;
    const row = await withTenantContext(this.conn, this.tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT framework, status, sealed_sha256, completion_rate, strong_attestation_rate, control_mappings
         FROM ${this.schema}.access_review_evidence
         WHERE framework = $1
         ORDER BY period_end_at DESC
         LIMIT 1`,
        [framework],
      );
      return result.rows[0];
    });
    if (row === undefined) return null;
    return {
      framework,
      status: String(row["status"]),
      sealedSha256: row["sealed_sha256"] === null ? null : String(row["sealed_sha256"]),
      completionRate: Number(row["completion_rate"] ?? 0),
      strongAttestationRate: Number(row["strong_attestation_rate"] ?? 0),
      controlMappings: toStringArray(row["control_mappings"]),
    };
  }
}

export interface CertificationSchedulerOptions {
  readonly certify: () => Promise<readonly CertificationReport[]>;
  readonly intervalMs: number;
  readonly scheduler?: IntervalScheduler;
  readonly onReports?: (reports: readonly CertificationReport[]) => void;
  readonly onError?: (err: unknown) => void;
}

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** Runs the certification pass on start and then every `intervalMs`; `unref`'d so it never holds the process open. */
export class CertificationScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: CertificationSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    void this.run();
    this.handle = this.scheduler().setInterval(() => void this.run(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  private async run(): Promise<void> {
    try {
      const reports = await this.opts.certify();
      this.opts.onReports?.(reports);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}

export interface CertificationLifecycleOptions {
  readonly sources?: readonly EvidenceSource[];
  readonly scheduler?: IntervalScheduler;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
  readonly onReports?: (reports: readonly CertificationReport[]) => void;
  readonly onError?: (err: unknown) => void;
  readonly onSourceError?: (err: unknown) => void;
}

export interface CertificationLifecycle {
  readonly scheduler: CertificationScheduler;
  certifyOnce(): Promise<CertificationReport[]>;
}

/**
 * Wires a persistent certification engine over a live connection: on each pass it collects evidence
 * from the configured sources per framework, certifies each framework, and persists the sealed report.
 * Certifies per framework (not `certifyAll`) because access-review evidence is framework-specific.
 */
export function buildCertificationLifecycle(
  conn: PgConnection,
  config: CertificationConfig,
  opts: CertificationLifecycleOptions = {},
): CertificationLifecycle {
  const engine = buildPersistentCertificationEngine(conn, {
    tenantId: config.tenantId,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.ids !== undefined ? { ids: opts.ids } : {}),
  });
  const sources = opts.sources ?? defaultLiveSources(conn, config);
  const now = opts.now ?? (() => new Date());

  async function collect(
    framework: ComplianceFramework,
    at: string,
  ): Promise<ControlEvidence[]> {
    const all: ControlEvidence[] = [];
    for (const source of sources) {
      try {
        all.push(...(await source.collect(framework, at)));
      } catch (err) {
        opts.onSourceError?.(err);
      }
    }
    return all;
  }

  async function certifyOnce(): Promise<CertificationReport[]> {
    const at = now().toISOString();
    const reports: CertificationReport[] = [];
    for (const framework of config.frameworks) {
      const evidence = await collect(framework, at);
      reports.push(await engine.certify(framework, evidence));
    }
    return reports;
  }

  const scheduler = new CertificationScheduler({
    certify: certifyOnce,
    intervalMs: config.intervalMs,
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    ...(opts.onReports !== undefined ? { onReports: opts.onReports } : {}),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });

  return { scheduler, certifyOnce };
}

export function defaultLiveSources(
  conn: PgConnection,
  config: CertificationConfig,
): EvidenceSource[] {
  const sources: EvidenceSource[] = [
    encryptionCoverageSource(new EncryptionApplier(conn), config.schema),
  ];
  if (config.drReadiness) {
    sources.push(drReadinessSource(new PostgresDrReadinessStore(conn)));
  }
  if (config.accessReviews) {
    sources.push(
      accessReviewSource(
        new PostgresAccessReviewEvidenceReader(conn, config.tenantId, config.schema),
      ),
    );
  }
  return sources;
}

function toStringArray(value: unknown): string[] {
  const raw = typeof value === "string" ? safeParse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
