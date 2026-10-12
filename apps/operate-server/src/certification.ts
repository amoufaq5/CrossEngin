import { readFile } from "node:fs/promises";

import { z } from "zod";
import {
  COMPLIANCE_FRAMEWORKS,
  evidenceFromAccessReviewEvidence,
  evidenceFromDrReadiness,
  evidenceFromEncryptionCoverage,
  evidenceFromForensicChain,
  type AccessReviewEvidenceLike,
  type CertificationReport,
  type Clock,
  type ComplianceFramework,
  type ControlEvidence,
  type DrReadinessLike,
  type IdGenerator,
} from "@crossengin/certification-runtime";
import { buildPersistentCertificationEngine } from "@crossengin/certification-runtime-pg";
import {
  EncryptionApplier,
  scopeFilter,
  type PgConnection,
} from "@crossengin/kernel-pg";
import { PostgresDrReadinessStore } from "@crossengin/dr-runtime-pg";
import { withTenantContext } from "@crossengin/access-reviews-runtime-pg";
import {
  ChainedLogEntrySchema,
  verifyChainIntegrity,
  type ChainedLogEntry,
} from "@crossengin/forensics";

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
    forensicChain: z.boolean().default(true),
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
  latest(scope: string | null): Promise<{ readonly report: DrReadinessLike } | null>;
}

/**
 * The most recent persisted DR-readiness snapshot (the dr-readiness lifecycle is the producer).
 *
 * `scope` is threaded through because the store's `latest()` took none: it was
 * `ORDER BY generated_at DESC LIMIT 1` with no predicate, and **a table's owner bypasses RLS**, so
 * it answered with whichever tenant's snapshot was newest. That is a wrong answer anywhere, but
 * here it is a wrong answer *inside a SOC 2 evidence pack* — this source's output is sealed into a
 * certification report as the deployment's disaster-recovery evidence. Every other source in
 * `defaultLiveSources` already took `config.tenantId`; this was the one that did not, so the scope
 * was in hand the whole time and the store had nowhere to receive it.
 */
export function drReadinessSource(
  provider: DrReadinessSnapshotProvider,
  scope: string | null,
  controlId = "resilience.dr_readiness",
): EvidenceSource {
  return {
    async collect(_framework, at) {
      const latest = await provider.latest(scope);
      if (latest === null) return [];
      return [evidenceFromDrReadiness(controlId, latest.report, at)];
    },
  };
}

/**
 * What an access-review lookup found, with **"looked and found none" kept apart from "could not
 * look"**.
 *
 * Those were one `null` before, and the conflation was the costly half of ADR-0334's finding. The
 * table had no writer at all, so the adapter answered `null` on every call for every deployment —
 * and `assessControl` turns an empty evidence list into `not_assessed` with the finding *"no
 * access_review_campaign evidence supplied"*. That sentence is a claim about the **tenant**: it
 * reads as *you did not run your access reviews*. The truth was a claim about the **deployment**:
 * nothing in the build could supply it, so `access.periodic_review` could never be assessed and
 * `certifiable` was therefore `false` in every report ever produced — a verdict that carried no
 * information while looking like one. The two call for opposite remedies (run a campaign; ship a
 * store) and the report could not tell them apart.
 *
 * `unscoped` is what survives now that a writer exists: `--certification-config` defaults
 * `tenantId` to `null` and this table is tenant-isolated with no platform arm, so the default
 * configuration still cannot look. That is reported rather than inferred — `accessReviewSource`
 * **throws** `AccessReviewEvidenceUnavailableError` for it, which reaches the existing
 * `onSourceError` sink and prints as `[certification] evidence source error`, while the control
 * stays `not_assessed` exactly as before. Fail-closed on the verdict, loud on the cause.
 */
export type AccessReviewEvidenceLookup =
  | { readonly kind: "evidence"; readonly evidence: AccessReviewEvidenceLike }
  /** The table was read in a real scope and holds no sealed pack for this framework. */
  | { readonly kind: "none" }
  /** No scope was in hand, so no answer about any tenant is available. */
  | { readonly kind: "unscoped"; readonly detail: string };

export interface AccessReviewEvidenceReader {
  latestSealed(
    framework: ComplianceFramework,
  ): Promise<AccessReviewEvidenceLookup>;
}

/** Raised when the access-review signal could not be gathered at all, as opposed to gathered empty. */
export class AccessReviewEvidenceUnavailableError extends Error {
  constructor(
    readonly framework: ComplianceFramework,
    detail: string,
  ) {
    super(
      `access-review evidence for ${framework} could not be gathered: ${detail}. ` +
        `The control stays not_assessed, so the framework cannot be certifiable until this is fixed.`,
    );
    this.name = "AccessReviewEvidenceUnavailableError";
  }
}

/** The latest sealed access-review evidence pack for the framework (per-framework, tenant-scoped). */
export function accessReviewSource(
  reader: AccessReviewEvidenceReader,
  controlId = "access.periodic_review",
): EvidenceSource {
  return {
    async collect(framework, at) {
      const lookup = await reader.latestSealed(framework);
      if (lookup.kind === "unscoped") {
        throw new AccessReviewEvidenceUnavailableError(framework, lookup.detail);
      }
      if (lookup.kind === "none") return [];
      return [evidenceFromAccessReviewEvidence(controlId, lookup.evidence, at)];
    },
  };
}

/**
 * Reads the latest sealed `access_review_evidence` row for a framework.
 *
 * Two things were wrong with this read and the second was live.
 *
 * It carried **no `tenant_id` predicate**, leaning on `withTenantContext` alone — and a table's
 * owner bypasses RLS, which is an ordinary deployment. Measured on a fresh cluster as the owner,
 * with one sealed pack belonging to tenant B and none to tenant A: `latestSealed` answered A's
 * certification with **B's pack**, and A's SOC 2 report then read `access.periodic_review`
 * *satisfied* at 100% completion with B's `sealedSha256` as its `detailRef` — a compliance report
 * citing, as its proof, a digest over another tenant's bundle. As a non-owner the same call
 * answered `null`. That is ADR-0333's class in the one place where a wrong scalar is a false
 * compliance claim, and `scopeFilter`'s **strict** spelling is the fix: `tenant_id` is `NOT NULL`
 * here with a single `ALL`-scope isolation policy and no platform arm, so a scope's rows are a
 * closed set and there is no platform pack a tenant is meant to be shown.
 *
 * And it took **any** status, ordered by `period_end_at` alone. `evidenceFromAccessReviewEvidence`
 * then reported an unsealed pack as a *deficiency* — so one `draft` row with a later period end
 * hid the sealed pack behind it and turned a satisfied control into a failing one. The statuses are
 * filtered to the three `SEALED_EVIDENCE_STATUSES` the assessor accepts, and `evidence_id` is the
 * tiebreak so the ordering is total.
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
  ): Promise<AccessReviewEvidenceLookup> {
    const tenantId = this.tenantId;
    if (tenantId === null) {
      return {
        kind: "unscoped",
        detail:
          `${this.schema}.access_review_evidence is tenant-scoped (tenant_id is NOT NULL with one ` +
          `isolation policy and no platform arm) and this certification names no tenant — set ` +
          `tenantId in --certification-config, or set accessReviews:false to certify without the signal`,
      };
    }
    const scope = scopeFilter(tenantId, 2);
    const row = await withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT framework, status, sealed_sha256, completion_rate, strong_attestation_rate, control_mappings
         FROM ${this.schema}.access_review_evidence
         WHERE framework = $1
           AND ${scope.sql}
           AND status IN ('sealed', 'submitted_to_auditor', 'accepted_by_auditor')
         ORDER BY period_end_at DESC, evidence_id DESC
         LIMIT 1`,
        [framework, ...scope.params],
      );
      return result.rows[0];
    });
    if (row === undefined) return { kind: "none" };
    return {
      kind: "evidence",
      evidence: {
        framework,
        status: String(row["status"]),
        sealedSha256:
          row["sealed_sha256"] === null ? null : String(row["sealed_sha256"]),
        // `NUMERIC` arrives from node-postgres as a **string** (ADR-0331), so these two have always
        // needed the coercion; what changed is that a non-finite column now refuses rather than
        // becoming `0`, which would have read as a 0% completion rate.
        completionRate: requireRate(row["completion_rate"], "completion_rate"),
        strongAttestationRate: requireRate(
          row["strong_attestation_rate"],
          "strong_attestation_rate",
        ),
        controlMappings: toStringArray(row["control_mappings"]),
      },
    };
  }
}

export interface ForensicChainReader {
  loadChain(): Promise<readonly ChainedLogEntry[]>;
}

/**
 * Verifies a persisted tamper-evident hash-chain. An **empty** chain yields no evidence (the audit
 * control stays `not_assessed` — a valid-by-vacuity empty log must not read as a satisfied control);
 * a non-empty chain is folded from genesis by `verifyChainIntegrity`.
 */
export function forensicChainSource(
  reader: ForensicChainReader,
  controlId = "audit.tamper_evident_log",
): EvidenceSource {
  return {
    async collect(_framework, at) {
      const entries = await reader.loadChain();
      if (entries.length === 0) return [];
      return [evidenceFromForensicChain(controlId, verifyChainIntegrity(entries), at)];
    },
  };
}

/**
 * Loads the ordered `forensic_chain_entries` for a scope so the chain can be verified from genesis.
 * A tenant chain is read within the tenant's RLS context; a null tenant reads the platform chain
 * (rows with `tenant_id IS NULL`). Entries are ordered by `sequence_number` ascending — the whole
 * chain, since integrity verification starts at the genesis hash.
 */
export class PostgresForensicChainReader implements ForensicChainReader {
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

  async loadChain(): Promise<readonly ChainedLogEntry[]> {
    const sql = `SELECT sequence_number, kind, recorded_at, actor_reference, payload_sha256,
        payload_size_bytes, prior_entry_hash, entry_hash, signing_key_fingerprint, signature
      FROM ${this.schema}.forensic_chain_entries
      ORDER BY sequence_number ASC`;
    const rows =
      this.tenantId === null
        ? (await this.conn.query<Record<string, unknown>>(sql)).rows
        : await withTenantContext(this.conn, this.tenantId, async (tx) =>
            (await tx.query<Record<string, unknown>>(sql)).rows,
          );
    return rows.map((row) =>
      ChainedLogEntrySchema.parse({
        sequenceNumber: Number(row["sequence_number"]),
        kind: String(row["kind"]),
        recordedAt: toIso(row["recorded_at"]),
        actorReference: String(row["actor_reference"]),
        payloadSha256: String(row["payload_sha256"]),
        payloadSizeBytes: Number(row["payload_size_bytes"]),
        priorEntryHash: String(row["prior_entry_hash"]),
        entryHash: String(row["entry_hash"]),
        signingKeyFingerprint: String(row["signing_key_fingerprint"]),
        signature: String(row["signature"]),
      }),
    );
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
    sources.push(drReadinessSource(new PostgresDrReadinessStore(conn), config.tenantId));
  }
  if (config.accessReviews) {
    sources.push(
      accessReviewSource(
        new PostgresAccessReviewEvidenceReader(conn, config.tenantId, config.schema),
      ),
    );
  }
  if (config.forensicChain) {
    sources.push(
      forensicChainSource(
        new PostgresForensicChainReader(conn, config.tenantId, config.schema),
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

/**
 * A `NUMERIC(5, 4)` column as a rate, refusing rather than defaulting.
 *
 * The old `Number(row[...] ?? 0)` turned an unreadable column into `0`, i.e. into a **0% completion
 * rate** — a figure that fails the control. Fail-closed is right for a verdict and wrong for an
 * input: a value nobody can read is not evidence of a deficient review, and the throw reaches
 * `onSourceError` where the row id can be chased.
 */
function requireRate(value: unknown, column: string): number {
  // `Number(null)` is `0` and `Number("")` is `0`, so a finiteness check alone is exactly the hole
  // the old `?? 0` was: both would have read as a 0% completion rate rather than as unreadable.
  const n =
    value === null || value === undefined || value === ""
      ? Number.NaN
      : typeof value === "number"
        ? value
        : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `access_review_evidence.${column} is not a finite number: ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
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
